"""Two-phase presigned upload: register, then complete.

    POST /api/cases/{case_id}/assets/register            -> asset_id + upload_url
    PUT  <upload_url>                                     (browser -> S3, direct)
    POST /api/cases/{case_id}/assets/{asset_id}/complete  -> verified, sized, hashed

Phase one mints the row and a signed PUT; phase two is the only point at which
this service sees the bytes, so that is where the declared MIME type gets tested
against the real file signature and the checksum gets taken. Between the two the
row sits at `awaiting_upload` and counts against the case quota, which is what
stops a client minting a thousand URLs and never using them.

The direct-upload route in `cases.py` stays for CLI and test convenience; this
is the path the browser takes.
"""

from __future__ import annotations

import io
import re
import uuid
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.api.cases import require_auth
from app.core import db, storage, validation
from app.schemas.contracts import (
    AssetRole,
    AssetStatus,
    RegisterAssetRequest,
    RegisterAssetResponse,
)


def _error_body(message: str) -> dict[str, Any]:
    return {"error": message}


class ErrorEnvelopeRoute(APIRoute):
    """Render this router's errors as `{"error": "..."}`.

    The Next.js client reads `body.error` and falls back to a generic string
    otherwise, so FastAPI's default `{"detail": ...}` turns every rejection into
    "something went wrong". Doing it with a route class keeps the change inside
    this file - an app-wide handler would mean editing main.py.
    """

    def get_route_handler(self):
        original = super().get_route_handler()

        async def handler(request: Request) -> Response:
            try:
                return await original(request)
            # Starlette's base class, so a dependency raising either flavour of
            # HTTPException gets the same envelope.
            except StarletteHTTPException as e:
                detail = e.detail
                message = detail if isinstance(detail, str) else str(detail)
                return JSONResponse(
                    status_code=e.status_code,
                    content=_error_body(message),
                    headers=getattr(e, "headers", None),
                )
            except RequestValidationError as e:
                fields = [
                    ".".join(str(p) for p in err.get("loc", ()) if p != "body")
                    for err in e.errors()
                ]
                return JSONResponse(
                    status_code=422,
                    content={
                        "error": "invalid request body: " + ", ".join(f for f in fields if f),
                        "fields": fields,
                    },
                )

        return handler


router = APIRouter(prefix="/api/cases", tags=["assets"], route_class=ErrorEnvelopeRoute)

# The header the client must echo on its PUT. S3 signs Content-Type into the
# presigned URL, so a mismatch is a 403 from S3, not a validation error here.
CONTENT_TYPE_HEADER = "X-Required-Content-Type"

_SAFE_FILENAME = re.compile(r"[^A-Za-z0-9._-]+")


def _fail(err: validation.ValidationError) -> HTTPException:
    return HTTPException(status_code=err.status_code, detail=err.detail)


# --------------------------------------------------------------------------
# Request / response shapes
# --------------------------------------------------------------------------

# The shipped client speaks `slot_key` + `asset_type`; contracts.py speaks
# `role`. The contract is frozen and the client is deployed, so the endpoint
# accepts either and normalizes here rather than forcing a change on either end.
_SLOT_ROLES = {
    "model": AssetRole.NAMEPLATE,
    "nameplate": AssetRole.NAMEPLATE,
    "additional": AssetRole.INTERIOR,
    "interior": AssetRole.INTERIOR,
    "video": AssetRole.VIDEO,
}


class RegisterAssetBody(BaseModel):
    """Superset of `contracts.RegisterAssetRequest`, accepting the client's dialect."""

    model_config = ConfigDict(extra="ignore")

    filename: str = ""
    mime_type: str = ""
    size_bytes: Optional[int] = None
    role: Optional[str] = None
    slot_key: Optional[str] = None
    asset_type: Optional[str] = None

    def resolved_role(self) -> AssetRole:
        """`role` wins; then `slot_key`; then `asset_type`; then OTHER."""
        if self.role:
            try:
                return AssetRole(self.role.strip().lower())
            except ValueError:
                raise HTTPException(
                    status_code=400,
                    detail=f"unknown role '{self.role}' - expected one of "
                           + ", ".join(r.value for r in AssetRole),
                )
        if self.slot_key:
            slot = self.slot_key.strip().lower()
            if slot in _SLOT_ROLES:
                return _SLOT_ROLES[slot]
        if (self.asset_type or "").strip().lower() == "video":
            return AssetRole.VIDEO
        return AssetRole.OTHER

    def as_contract(self, role: AssetRole) -> RegisterAssetRequest:
        """Proof that the normalized request still satisfies the frozen contract."""
        return RegisterAssetRequest(
            filename=self.filename,
            mime_type=self.mime_type,
            role=role,
            size_bytes=self.size_bytes,
        )


class RegisterAssetResult(RegisterAssetResponse):
    """`RegisterAssetResponse` plus what the client needs to perform the PUT.

    Extends rather than edits: every field the frozen contract declares is still
    present and still means the same thing.
    """

    upload_method: str = "PUT"
    upload_provider: str = "s3"
    # Must be echoed as the Content-Type header on the PUT; it is signed in.
    content_type: str
    role: AssetRole
    slot_key: Optional[str] = None


def _safe_filename(filename: str) -> str:
    """Storage keys are path-shaped, so a filename may not contain a path."""
    name = _SAFE_FILENAME.sub("_", filename.replace("\\", "/").split("/")[-1]).strip("._")
    return name[:120] or "upload.bin"


async def _require_case(case_id: str) -> dict[str, Any]:
    row = await db.fetchrow("SELECT case_id FROM cases WHERE case_id=$1", case_id)
    if not row:
        raise HTTPException(status_code=404, detail="case not found")
    return dict(row)


async def _require_asset(case_id: str, asset_id: str) -> dict[str, Any]:
    row = await db.fetchrow(
        "SELECT * FROM assets WHERE asset_id=$1 AND case_id=$2", asset_id, case_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="asset not found")
    return dict(row)


def _image_dimensions(data: bytes) -> tuple[Optional[int], Optional[int]]:
    """Best effort. A HEIC without pillow-heif decodes to nothing, and that is
    not a reason to fail an otherwise valid upload."""
    try:
        from PIL import Image

        with Image.open(io.BytesIO(data)) as img:
            return img.width, img.height
    except Exception:
        return None, None


# ---------------------------------------------------------------------------


@router.post(
    "/{case_id}/assets/register",
    response_model=RegisterAssetResult,
    status_code=201,
    summary="Mint an asset id and a presigned S3 PUT url",
    description=(
        "Accepts either dialect: `role` (contracts.RegisterAssetRequest) or the "
        "client's `slot_key` / `asset_type`, normalized to an AssetRole and "
        "echoed back as `role`.\n\n"
        "The client must PUT the bytes to `upload_url` with a `Content-Type` "
        "header exactly equal to the registered `mime_type` - that value is part "
        "of the URL signature and S3 answers 403 on any other value. It comes "
        "back as `content_type` and in the `X-Required-Content-Type` header. "
        "Call `/complete` afterwards; until then the asset stays at "
        "`awaiting_upload` and is invisible to the pipeline."
    ),
)
async def register_asset(
    case_id: str,
    body: RegisterAssetBody,
    response: Response,
    _: None = Depends(require_auth),
) -> RegisterAssetResult:
    await _require_case(case_id)

    role = body.resolved_role()
    filename = (body.filename or "").strip()
    mime = validation.normalize_mime(body.mime_type)
    if not filename or not mime:
        raise HTTPException(status_code=400, detail="filename and mime_type are required")

    if not validation.is_allowed_mime(mime, role):
        raise HTTPException(
            status_code=400,
            detail=f"mime_type '{mime}' is not allowed for role '{role.value}'",
        )

    contract = body.as_contract(role)

    try:
        validation.validate_size(contract.size_bytes, role)
        await validation.check_quota(case_id)
    except validation.ValidationError as e:
        raise _fail(e) from e

    asset_id = f"asset_{uuid.uuid4().hex[:12]}"
    key = storage.raw_key(case_id, asset_id, _safe_filename(filename))
    upload_url, expires_at = await storage.create_signed_upload_url(key, mime)

    await db.execute(
        """INSERT INTO assets (asset_id, case_id, role, mime_type, size_bytes,
                               filename, storage_key_raw, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)""",
        asset_id,
        case_id,
        role.value,
        mime,
        contract.size_bytes,
        filename,
        key,
        AssetStatus.AWAITING_UPLOAD.value,
    )

    response.headers[CONTENT_TYPE_HEADER] = mime
    return RegisterAssetResult(
        asset_id=asset_id,
        upload_url=upload_url,
        storage_path=key,
        expires_at=expires_at,
        content_type=mime,
        role=role,
        # Not persisted - `assets` has no column for it, and role maps back 1:1.
        slot_key=body.slot_key,
    )


@router.post(
    "/{case_id}/assets/{asset_id}/complete",
    summary="Verify an uploaded object and admit it to the pipeline",
    description=(
        "Idempotent: an asset already past `awaiting_upload` is returned as-is. "
        "Bytes whose signature contradicts the declared mime_type are rejected "
        "with 400 and the asset is marked `failed`."
    ),
)
async def complete_asset(
    case_id: str, asset_id: str, _: None = Depends(require_auth)
) -> dict[str, Any]:
    asset = await _require_asset(case_id, asset_id)

    if asset["status"] in (AssetStatus.UPLOADED.value, AssetStatus.READY.value):
        return {
            "asset_id": asset_id,
            "case_id": case_id,
            "status": asset["status"],
            "checksum": asset["checksum"],
            "size_bytes": asset["size_bytes"],
            "width": asset["width"],
            "height": asset["height"],
            "duplicate": False,
            "original_asset_id": None,
            "idempotent": True,
        }

    key = asset["storage_key_raw"]
    if not key or not await storage.exists(key):
        raise HTTPException(
            status_code=400, detail="no object at the registered storage key - PUT it first"
        )

    data = await storage.download(key)
    checksum = validation.compute_checksum(data)
    mime = asset["mime_type"]

    if not validation.check_magic_bytes(data, mime):
        await db.execute(
            "UPDATE assets SET status=$2, error=$3 WHERE asset_id=$1",
            asset_id,
            AssetStatus.FAILED.value,
            f"file signature does not match declared mime_type '{mime}'",
        )
        raise HTTPException(
            status_code=400,
            detail=f"file signature does not match declared mime_type '{mime}'",
        )

    try:
        validation.validate_size(len(data), asset["role"])
    except validation.ValidationError as e:
        await db.execute(
            "UPDATE assets SET status=$2, error=$3 WHERE asset_id=$1",
            asset_id,
            AssetStatus.FAILED.value,
            e.detail,
        )
        raise _fail(e) from e

    original = await validation.check_duplicate(case_id, checksum, asset_id)
    if original:
        # No duplicate_of column in the schema: point this row at the original's
        # bytes and mark it ready, so nothing downstream re-processes them.
        await db.execute(
            """UPDATE assets a
                  SET status=$2, checksum=$3, size_bytes=$4,
                      storage_key_raw = o.storage_key_raw,
                      storage_key_normalized = o.storage_key_normalized,
                      storage_key_thumb = o.storage_key_thumb,
                      width = o.width, height = o.height,
                      duration_sec = o.duration_sec, error = NULL
                 FROM assets o
                WHERE a.asset_id=$1 AND o.asset_id=$5""",
            asset_id,
            AssetStatus.READY.value,
            checksum,
            len(data),
            original,
        )
        return {
            "asset_id": asset_id,
            "case_id": case_id,
            "status": AssetStatus.READY.value,
            "checksum": checksum,
            "size_bytes": len(data),
            "duplicate": True,
            "original_asset_id": original,
            "note": f"identical bytes already stored as {original}; reusing them",
        }

    width, height = (
        _image_dimensions(data) if (mime or "").startswith("image/") else (None, None)
    )
    await db.execute(
        """UPDATE assets SET status=$2, checksum=$3, size_bytes=$4,
                             width=$5, height=$6, error=NULL
            WHERE asset_id=$1""",
        asset_id,
        AssetStatus.UPLOADED.value,
        checksum,
        len(data),
        width,
        height,
    )
    return {
        "asset_id": asset_id,
        "case_id": case_id,
        "status": AssetStatus.UPLOADED.value,
        "checksum": checksum,
        "size_bytes": len(data),
        "width": width,
        "height": height,
        "duplicate": False,
        "original_asset_id": None,
    }


@router.get(
    "/{case_id}/assets",
    summary="List a case's assets with fresh signed download urls",
)
async def list_assets(case_id: str, _: None = Depends(require_auth)) -> dict[str, Any]:
    await _require_case(case_id)
    rows = await db.fetch(
        "SELECT * FROM assets WHERE case_id=$1 ORDER BY created_at ASC, asset_id ASC",
        case_id,
    )

    out = []
    for row in rows:
        item = {
            "asset_id": row["asset_id"],
            "role": row["role"],
            "mime_type": row["mime_type"],
            "size_bytes": row["size_bytes"],
            "filename": row["filename"],
            "checksum": row["checksum"],
            "status": row["status"],
            "width": row["width"],
            "height": row["height"],
            "duration_sec": float(row["duration_sec"]) if row["duration_sec"] is not None else None,
            "error": row["error"],
            "created_at": row["created_at"],
            "storage_path": row["storage_key_raw"],
            "download_url": None,
        }
        # Signed on every read rather than stored: they expire, and a stale URL
        # in the database is worse than no URL at all.
        if row["storage_key_raw"] and row["status"] != AssetStatus.AWAITING_UPLOAD.value:
            item["download_url"] = await storage.create_signed_download_url(
                row["storage_key_raw"]
            )
        out.append(item)

    return {"case_id": case_id, "count": len(out), "assets": out}
