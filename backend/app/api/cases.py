"""Case routes.

Phase A scope: create a case, attach media, run the pipeline synchronously,
read the result back. The staged runner, presigned uploads and SSE arrive in
Phase B; every stage output is already persisted to `stage_runs` here so that
change is additive rather than a rewrite.
"""

from __future__ import annotations

import json
import time
import uuid
from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ConfigDict

from app.config import settings
from app.core import db, storage, validation
from app.pipeline import safety
from app.pipeline.stages import diagnose, identify
from app.schemas.contracts import (
    AssetRole,
    CaseStatus,
    CreateCaseRequest,
    CreateCaseResponse,
    StageName,
    StageStatus,
    SubmitInputRequest,
)

router = APIRouter(prefix="/api/cases", tags=["cases"])
_bearer = HTTPBearer(auto_error=False)


async def require_auth(
    creds: Annotated[Optional[HTTPAuthorizationCredentials], Depends(_bearer)],
) -> None:
    """Shared-secret auth between the Next.js proxy and this service.

    Without it, anyone who can guess a case id can trigger a paid pipeline.
    """
    if not settings.api_bearer_token:
        return  # unset in local dev; /health reports it as unconfigured
    if not creds or creds.credentials != settings.api_bearer_token:
        raise HTTPException(status_code=401, detail="invalid or missing bearer token")


async def _get_case(case_id: str) -> dict[str, Any]:
    row = await db.fetchrow("SELECT * FROM cases WHERE case_id=$1", case_id)
    if not row:
        raise HTTPException(status_code=404, detail="case not found")
    return dict(row)


async def _record_stage(
    case_id: str, stage: StageName, status: StageStatus, output: Any, usage: dict, error: str | None = None
) -> None:
    """Persist a stage result. The contract: a finished stage is on disk, always."""
    await db.execute(
        """INSERT INTO stage_runs (stage_run_id, case_id, stage, status, output, usage,
                                   error, attempts, completed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,1,NOW())
           ON CONFLICT (case_id, stage) DO UPDATE SET
             status=EXCLUDED.status, output=EXCLUDED.output, usage=EXCLUDED.usage,
             error=EXCLUDED.error, attempts=stage_runs.attempts+1,
             completed_at=EXCLUDED.completed_at""",
        f"sr_{uuid.uuid4().hex[:12]}", case_id, stage.value, status.value,
        output, usage, error,
    )


# ---------------------------------------------------------------------------


@router.post("", response_model=CreateCaseResponse, status_code=201)
async def create_case(body: CreateCaseRequest, _: None = Depends(require_auth)):
    case_id = f"case_{uuid.uuid4().hex}"
    await db.execute(
        "INSERT INTO cases (case_id, status, appliance_type_hint) VALUES ($1,$2,$3)",
        case_id, CaseStatus.CREATED.value, body.appliance_type_hint,
    )
    return CreateCaseResponse(case_id=case_id, status=CaseStatus.CREATED)


class _InputBody(BaseModel):
    """Accepts both our shape and the existing frontend's.

    Ours:      {symptom, error_code?, brand_hint?, model_hint?}
    Frontend:  {description, metadata?: {brand?, model?}, assets?: []}
    """

    model_config = ConfigDict(extra="ignore")

    symptom: Optional[str] = None
    description: Optional[str] = None
    error_code: Optional[str] = None
    brand_hint: Optional[str] = None
    model_hint: Optional[str] = None
    metadata: Optional[dict[str, Any]] = None

    def normalized(self) -> SubmitInputRequest:
        meta = self.metadata or {}
        symptom = (self.symptom or self.description or "").strip()
        if not symptom:
            raise HTTPException(status_code=400, detail="a symptom description is required")
        return SubmitInputRequest(
            symptom=symptom,
            error_code=self.error_code or meta.get("error_code"),
            brand_hint=self.brand_hint or meta.get("brand"),
            model_hint=self.model_hint or meta.get("model"),
        )


@router.post("/{case_id}/input")
async def submit_input(case_id: str, raw: _InputBody, _: None = Depends(require_auth)):
    await _get_case(case_id)
    body = raw.normalized()
    await db.execute(
        """UPDATE cases SET symptom=$2, error_code=$3, brand_hint=$4, model_hint=$5,
                            updated_at=NOW() WHERE case_id=$1""",
        case_id, body.symptom, body.error_code, body.brand_hint, body.model_hint,
    )
    return {"case_id": case_id, "symptom": body.symptom}


@router.post("/{case_id}/assets", status_code=201)
async def attach_asset(
    case_id: str,
    role: Annotated[AssetRole, Form()],
    file: Annotated[UploadFile, File()],
    _: None = Depends(require_auth),
):
    """Direct server-side upload.

    Convenient for testing and CLI use. The production path is the presigned
    PUT (Phase B) so large files never stream through this process.
    """
    await _get_case(case_id)
    data = await file.read()
    mime = file.content_type or "application/octet-stream"

    # Same gates as the presigned path. Without these this route was a hole:
    # anything could be posted as any content type, and a missing checksum made
    # the resulting row invisible to duplicate detection.
    try:
        await validation.check_quota(case_id)
        if not validation.is_allowed_mime(mime, role):
            raise validation.ValidationError(400, f"{mime} not allowed for role {role.value}")
        validation.validate_size(len(data), role)
        if not validation.check_magic_bytes(data, mime):
            raise validation.ValidationError(400, f"file signature does not match {mime}")
    except validation.ValidationError as e:
        raise HTTPException(status_code=e.status_code, detail=str(e.detail))

    checksum = validation.compute_checksum(data)
    asset_id = f"asset_{uuid.uuid4().hex[:12]}"
    key = storage.raw_key(case_id, asset_id, file.filename or "upload.bin")
    await storage.upload(key, data, mime)
    await db.execute(
        """INSERT INTO assets (asset_id, case_id, role, mime_type, size_bytes,
                               filename, checksum, storage_key_raw, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'uploaded')""",
        asset_id, case_id, role.value, mime, len(data), file.filename, checksum, key,
    )
    return {"asset_id": asset_id, "role": role.value, "size_bytes": len(data), "key": key}


@router.post("/{case_id}/run")
async def run_pipeline(case_id: str, _: None = Depends(require_auth)):
    """Identify -> safety gate -> diagnose, synchronously.

    Each stage is written to `stage_runs` as it finishes, so the result outlives
    this request even though this request is what produced it.
    """
    case = await _get_case(case_id)
    if not case.get("symptom"):
        raise HTTPException(status_code=400, detail="submit a symptom via /input first")

    assets = await db.fetch(
        "SELECT * FROM assets WHERE case_id=$1 AND status<>'failed' ORDER BY created_at", case_id
    )
    images: list[tuple[bytes, str]] = []
    for a in assets:
        if (a["mime_type"] or "").startswith("image/") and a["storage_key_raw"]:
            images.append((await storage.download(a["storage_key_raw"]), a["mime_type"]))

    await db.execute("UPDATE cases SET status=$2, updated_at=NOW() WHERE case_id=$1",
                     case_id, CaseStatus.PROCESSING.value)
    started, cost = time.time(), 0.0

    # --- identify ---
    ident, usage = await identify.run(
        images, brand_hint=case.get("brand_hint"), model_hint=case.get("model_hint")
    )
    cost += usage.get("cost") or 0
    await _record_stage(case_id, StageName.IDENTIFY, StageStatus.DONE,
                        json.loads(ident.model_dump_json()), usage)
    if ident.manual_id:
        await db.execute("UPDATE cases SET manual_id=$2 WHERE case_id=$1", case_id, ident.manual_id)

    # --- manual + safety gate ---
    manual = await db.fetchrow("SELECT * FROM manuals WHERE manual_id=$1", ident.manual_id) if ident.manual_id else None
    manual_pdf = await storage.download(manual["pdf_path"]) if manual else None
    hazards = safety.parse_hazards(
        await db.fetchval(
            "SELECT attributes->'hazard_classes' FROM appliances WHERE manual_id=$1 LIMIT 1",
            ident.manual_id) if ident.manual_id else []
    )
    assessment = safety.assess(
        hazards,
        appliance_type=ident.appliance_type,
        scope_note=manual["scope_note"] if manual else None,
        scope_pages=list(manual["scope_pages"] or []) if manual else [],
        identified=bool(ident.manual_id),
    )

    # --- diagnose ---
    summary, usage = await diagnose.run(
        manual_pdf, ident, case["symptom"], error_code=case.get("error_code"), images=images
    )
    summary.safety = assessment
    cost += usage.get("cost") or 0
    await _record_stage(case_id, StageName.DIAGNOSE, StageStatus.DONE,
                        json.loads(summary.model_dump_json()), usage)

    await db.execute("UPDATE cases SET status=$2, updated_at=NOW() WHERE case_id=$1",
                     case_id, CaseStatus.READY.value)

    return {
        "case_id": case_id,
        "identity": json.loads(ident.model_dump_json()),
        "summary": json.loads(summary.model_dump_json()),
        "meta": {"duration_sec": round(time.time() - started, 1), "cost_usd": round(cost, 4)},
    }


@router.get("/{case_id}")
async def get_case(case_id: str, _: None = Depends(require_auth)):
    case = await _get_case(case_id)
    assets = await db.fetch("SELECT * FROM assets WHERE case_id=$1 ORDER BY created_at", case_id)
    stages = await db.fetch("SELECT * FROM stage_runs WHERE case_id=$1 ORDER BY created_at", case_id)

    out_assets = []
    for a in assets:
        d = dict(a)
        # Only sign for objects that exist. An asset still in awaiting_upload has
        # a key but no bytes behind it, and a URL to nothing is worse than none.
        if a["storage_key_raw"] and a["status"] != "awaiting_upload":
            d["url"] = await storage.create_signed_download_url(a["storage_key_raw"])
        else:
            d["url"] = None
        out_assets.append(d)

    by_stage = {s["stage"]: s["output"] for s in stages}
    return {
        "case_id": case_id,
        "status": case["status"],
        "symptom": case["symptom"],
        "manual_id": case["manual_id"],
        "identity": by_stage.get("identify"),
        "summary": by_stage.get("diagnose"),
        "assets": out_assets,
        "stages": [
            {"stage": s["stage"], "status": s["status"], "usage": s["usage"], "error": s["error"]}
            for s in stages
        ],
    }
