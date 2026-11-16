"""Staged, resumable, streamable pipeline execution.

The synchronous `POST /{case_id}/run` in `app.api.cases` does the same work,
but only inside one HTTP request: if the connection drops mid-diagnose the
money is spent and the answer is gone. This module runs the same stages against
`stage_runs` and `pipeline_events` instead, so:

  - `stage_runs` is the lease (claimed_at), the retry ledger (attempts), the
    idempotency key (input_hash) and the result store (output) at once;
  - `pipeline_events` is what a reconnecting client replays, so a reconnect
    costs a SELECT rather than another paid model call.

Nothing here is allowed to raise into its caller: a stage failure lands in
`stage_runs.status='failed'` with the error text and an `error` event, because
a background task that dies silently is worse than one that records why.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import random
import re
import uuid
from typing import Any, Awaitable, Callable, Optional, TypeVar

import asyncpg

from app.config import settings
from app.core import db, manuals, pdf, storage
from app.pipeline import safety
from app.pipeline.stages import diagnose, identify
from app.pipeline.stages import retrieve as retrieve_stage
from app.pipeline.stages import instruct as instruct_stage
from app.pipeline.stages import parts as parts_stage
from app.schemas.contracts import (
    ApplianceIdentity,
    CaseStatus,
    RepairSummary,
    StageName,
    StageResult,
    StageStatus,
)

log = logging.getLogger(__name__)

T = TypeVar("T")

# How long a 'running' row is trusted before another worker may steal it. Must
# comfortably exceed the slowest stage (diagnose with a full manual: ~90s).
LEASE_TIMEOUT = "10 minutes"

MAX_ATTEMPTS = 3
RETRY_BASE_DELAY = 1.0  # seconds; patched down in tests
# Contention retries for the per-case seq allocation, not stage retries.
EMIT_MAX_ATTEMPTS = 12


class PermanentStageError(RuntimeError):
    """A failure that retrying cannot fix (bad input, 4xx, schema violation)."""


# ---------------------------------------------------------------------------
# Input hashing
# ---------------------------------------------------------------------------


def _asset_fingerprint(asset: Any) -> str:
    """Identify an asset by content where we can, by id where we cannot.

    A checksum is preferable: re-uploading identical bytes under a new asset id
    should still hit the cached stage output.
    """
    if isinstance(asset, str):
        return asset
    if isinstance(asset, (list, tuple)):
        return ":".join(str(x) for x in asset if x)
    if isinstance(asset, dict):
        return str(asset.get("checksum") or asset.get("asset_id") or asset.get("id") or "")
    checksum = getattr(asset, "checksum", None)
    if checksum:
        return str(checksum)
    return str(getattr(asset, "asset_id", asset))


def compute_input_hash(
    stage: StageName | str,
    *,
    symptom: Optional[str] = None,
    error_code: Optional[str] = None,
    assets: Optional[list[Any]] = None,
    manual_id: Optional[str] = None,
    model: Optional[str] = None,
    brand_hint: Optional[str] = None,
    model_hint: Optional[str] = None,
    extra: Optional[dict[str, Any]] = None,
) -> str:
    """Stable sha256 over a stage's real inputs.

    Deterministic by construction: keys sorted, no timestamps, no uuids, assets
    reduced to sorted content fingerprints. Two runs with the same meaningful
    inputs must produce the same string or `should_skip` is useless.
    """
    payload: dict[str, Any] = {
        "stage": stage.value if isinstance(stage, StageName) else str(stage),
        "symptom": (symptom or "").strip(),
        "error_code": (error_code or "").strip(),
        "brand_hint": (brand_hint or "").strip(),
        "model_hint": (model_hint or "").strip(),
        "manual_id": manual_id or "",
        "model": model or "",
        "assets": sorted(f for f in (_asset_fingerprint(a) for a in (assets or [])) if f),
    }
    if extra:
        payload["extra"] = extra
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# stage_runs: lease, idempotency, persistence
# ---------------------------------------------------------------------------


def _stage_value(stage: StageName | str) -> str:
    return stage.value if isinstance(stage, StageName) else str(stage)


async def ensure_stage_row(case_id: str, stage: StageName | str) -> None:
    """Create the queued row if this stage has never been seen. Never resets one."""
    await db.execute(
        """INSERT INTO stage_runs (stage_run_id, case_id, stage, status)
           VALUES ($1,$2,$3,'queued')
           ON CONFLICT (case_id, stage) DO NOTHING""",
        f"sr_{uuid.uuid4().hex[:12]}",
        case_id,
        _stage_value(stage),
    )


async def claim_stage(case_id: str, stage: StageName | str) -> bool:
    """Atomically take the lease on a stage. True means this caller owns it.

    The stale-lease clause is the load-bearing part: a worker that is killed
    mid-stage leaves status='running' behind, and without a reclaim window that
    row is stranded forever and the case can never finish.
    """
    await ensure_stage_row(case_id, stage)
    row = await db.fetchrow(
        f"""UPDATE stage_runs
               SET status='running', claimed_at=NOW(), attempts=attempts+1, error=NULL
             WHERE case_id=$1 AND stage=$2
               AND (status='queued'
                    OR (status='running' AND claimed_at < NOW() - INTERVAL '{LEASE_TIMEOUT}'))
         RETURNING stage_run_id""",
        case_id,
        _stage_value(stage),
    )
    return row is not None


async def should_skip(
    case_id: str, stage: StageName | str, input_hash: str
) -> Optional[dict[str, Any]]:
    """Stored output for an already-completed identical run, else None.

    This is the difference between a reconnect costing a SELECT and costing
    another few cents of model time.
    """
    if not input_hash:
        return None
    row = await db.fetchrow(
        """SELECT output FROM stage_runs
            WHERE case_id=$1 AND stage=$2 AND status='done'
              AND input_hash IS NOT NULL AND input_hash=$3""",
        case_id,
        _stage_value(stage),
        input_hash,
    )
    if not row or row["output"] is None:
        return None
    output = row["output"]
    return json.loads(output) if isinstance(output, str) else dict(output)


async def record_stage(
    case_id: str,
    result: StageResult,
    *,
    input_hash: Optional[str] = None,
) -> None:
    """Persist a StageResult. A finished stage is on disk before anything else."""
    await db.execute(
        """INSERT INTO stage_runs (stage_run_id, case_id, stage, status, input_hash,
                                   output, usage, error, attempts, claimed_at, completed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,NULL,NOW())
           ON CONFLICT (case_id, stage) DO UPDATE SET
             status=EXCLUDED.status,
             input_hash=COALESCE(EXCLUDED.input_hash, stage_runs.input_hash),
             output=EXCLUDED.output, usage=EXCLUDED.usage, error=EXCLUDED.error,
             claimed_at=NULL, completed_at=NOW()""",
        f"sr_{uuid.uuid4().hex[:12]}",
        case_id,
        result.stage.value,
        result.status.value,
        input_hash,
        result.output,
        result.usage,
        result.error,
    )


# ---------------------------------------------------------------------------
# pipeline_events
# ---------------------------------------------------------------------------


async def emit(case_id: str, type: str, payload: Optional[dict[str, Any]] = None) -> int:
    """Append an event with a per-case monotonic seq. Returns the seq.

    seq is computed inside the INSERT so two concurrent writers cannot read the
    same max; the UNIQUE(case_id, seq) index is what actually decides, and the
    loser simply recomputes.
    """
    payload = payload or {}
    for attempt in range(EMIT_MAX_ATTEMPTS):
        try:
            return await db.fetchval(
                """INSERT INTO pipeline_events (case_id, seq, type, payload)
                   SELECT $1, COALESCE(MAX(seq),0)+1, $2, $3
                     FROM pipeline_events WHERE case_id=$1
                RETURNING seq""",
                case_id,
                type,
                payload,
            )
        except asyncpg.UniqueViolationError:
            # Another writer took this seq between our MAX() and our INSERT.
            # Jitter, or N concurrent writers collide again in lockstep.
            if attempt >= EMIT_MAX_ATTEMPTS - 1:
                raise
            await asyncio.sleep(random.uniform(0.002, 0.02) * (attempt + 1))
    raise RuntimeError("unreachable")


async def events_after(case_id: str, after: int = 0, limit: int = 500) -> list[dict[str, Any]]:
    rows = await db.fetch(
        """SELECT seq, case_id, type, payload, ts FROM pipeline_events
            WHERE case_id=$1 AND seq > $2 ORDER BY seq LIMIT $3""",
        case_id,
        after,
        limit,
    )
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Retry
# ---------------------------------------------------------------------------

_PERMANENT_STATUS = re.compile(r"\b(4\d\d)\b")
_RETRYABLE_4XX = {"408", "409", "425", "429"}


def is_permanent(exc: BaseException) -> bool:
    """400-class and validation errors are not worth a second call."""
    if isinstance(exc, PermanentStageError):
        return True
    if isinstance(exc, (ValueError, TypeError, KeyError, AttributeError)):
        # Pydantic's ValidationError is a ValueError; so is a schema mismatch.
        return True
    status = _PERMANENT_STATUS.search(str(exc))
    if status and status.group(1) not in _RETRYABLE_4XX:
        return True
    return False


async def with_retry(fn: Callable[[], Awaitable[T]], *, attempts: int = MAX_ATTEMPTS) -> T:
    last: BaseException
    for i in range(attempts):
        try:
            return await fn()
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 - classified below
            last = e
            if is_permanent(e) or i == attempts - 1:
                raise
            delay = RETRY_BASE_DELAY * (2**i)
            # Without this a retried model call is indistinguishable from a slow
            # one: a diagnose that took 3x normal left no trace of which it was.
            log.warning("attempt %d/%d failed (%s: %s); retrying in %.1fs",
                        i + 1, attempts, type(e).__name__, str(e)[:200], delay)
            await asyncio.sleep(delay)
    raise last  # pragma: no cover


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------


async def _set_case_status(case_id: str, status: CaseStatus) -> None:
    await db.execute(
        "UPDATE cases SET status=$2, updated_at=NOW() WHERE case_id=$1", case_id, status.value
    )
    await emit(case_id, "case_status", {"status": status.value})


async def _load_images(assets: list[dict[str, Any]]) -> list[tuple[bytes, str]]:
    images: list[tuple[bytes, str]] = []
    for a in assets:
        if (a.get("mime_type") or "").startswith("image/") and a.get("storage_key_raw"):
            images.append((await storage.download(a["storage_key_raw"]), a["mime_type"]))
    return images


async def _fail_stage(case_id: str, stage: StageName, exc: BaseException) -> None:
    message = f"{type(exc).__name__}: {exc}"
    log.exception("stage %s failed for case %s", stage.value, case_id)
    await record_stage(
        case_id,
        StageResult(stage=stage, status=StageStatus.FAILED, output={}, error=message),
    )
    await emit(case_id, "error", {"stage": stage.value, "error": message,
                                  "permanent": is_permanent(exc)})


async def run_case(case_id: str) -> dict[str, Any]:
    """identify -> safety gate -> diagnose, persisted and streamed.

    Functionally identical to `cases.run_pipeline`, but every step is claimed,
    persisted and announced, and no single stage failure takes the process down.
    """
    case_row = await db.fetchrow("SELECT * FROM cases WHERE case_id=$1", case_id)
    if not case_row:
        log.warning("run_case: no such case %s", case_id)
        return {"case_id": case_id, "status": "not_found"}
    case = dict(case_row)

    if not case.get("symptom"):
        await emit(case_id, "error", {"stage": None, "error": "no symptom submitted",
                                      "permanent": True})
        await _set_case_status(case_id, CaseStatus.FAILED)
        return {"case_id": case_id, "status": CaseStatus.FAILED.value}

    await _set_case_status(case_id, CaseStatus.PROCESSING)

    assets = [
        dict(a)
        for a in await db.fetch(
            "SELECT * FROM assets WHERE case_id=$1 AND status<>'failed' ORDER BY created_at",
            case_id,
        )
    ]

    identity_payload: Optional[dict[str, Any]] = None
    summary_payload: Optional[dict[str, Any]] = None

    # --- identify -------------------------------------------------------
    ident_hash = compute_input_hash(
        StageName.IDENTIFY,
        assets=assets,
        brand_hint=case.get("brand_hint"),
        model_hint=case.get("model_hint"),
        model=settings.model_default,
    )
    try:
        cached = await should_skip(case_id, StageName.IDENTIFY, ident_hash)
        if cached is not None:
            identity_payload = cached
            await emit(case_id, "stage_completed", {"stage": StageName.IDENTIFY.value,
                                                    "cached": True, "output": cached})
        elif not await claim_stage(case_id, StageName.IDENTIFY):
            await emit(case_id, "stage_skipped", {"stage": StageName.IDENTIFY.value,
                                                  "reason": "claimed by another worker"})
            return {"case_id": case_id, "status": "claimed_elsewhere"}
        else:
            await emit(case_id, "stage_started", {"stage": StageName.IDENTIFY.value})
            images = await _load_images(assets)

            async def _identify():
                return await identify.run(
                    images,
                    brand_hint=case.get("brand_hint"),
                    model_hint=case.get("model_hint"),
                )

            ident, usage = await with_retry(_identify)
            identity_payload = json.loads(ident.model_dump_json())
            await record_stage(
                case_id,
                StageResult(stage=StageName.IDENTIFY, status=StageStatus.DONE,
                            output=identity_payload, usage=usage),
                input_hash=ident_hash,
            )
            await emit(case_id, "stage_completed", {"stage": StageName.IDENTIFY.value,
                                                    "output": identity_payload, "usage": usage})
    except Exception as e:  # noqa: BLE001 - a stage failure must not kill the task
        await _fail_stage(case_id, StageName.IDENTIFY, e)
        await _set_case_status(case_id, CaseStatus.FAILED)
        return {"case_id": case_id, "status": CaseStatus.FAILED.value}

    ident = ApplianceIdentity(**(identity_payload or {}))
    await emit(case_id, "identity_resolved", {"identity": identity_payload})
    if ident.manual_id:
        await db.execute(
            "UPDATE cases SET manual_id=$2, updated_at=NOW() WHERE case_id=$1",
            case_id, ident.manual_id,
        )

    # --- manual + safety gate (deterministic, never a model call) --------
    manual = (
        await db.fetchrow("SELECT * FROM manuals WHERE manual_id=$1", ident.manual_id)
        if ident.manual_id
        else None
    )
    hazards = safety.parse_hazards(
        await db.fetchval(
            "SELECT attributes->'hazard_classes' FROM appliances WHERE manual_id=$1 LIMIT 1",
            ident.manual_id,
        )
        if ident.manual_id
        else []
    )
    assessment = safety.assess(
        hazards,
        appliance_type=ident.appliance_type,
        scope_note=manual["scope_note"] if manual else None,
        scope_pages=list(manual["scope_pages"] or []) if manual else [],
        identified=bool(ident.manual_id),
    )
    await emit(case_id, "safety_verdict", json.loads(assessment.model_dump_json()))

    # --- diagnose --------------------------------------------------------
    diag_hash = compute_input_hash(
        StageName.DIAGNOSE,
        symptom=case.get("symptom"),
        error_code=case.get("error_code"),
        assets=assets,
        manual_id=ident.manual_id,
        model=settings.model_diagnose,
        extra={
            "identity": ident.model_normalized or "",
            "level": ident.identity_level.value,
            # Retrieval changes what diagnose reads, so it must change the hash.
            "retrieval": settings.retrieval_top_k if settings.retrieval_enabled else 0,
        },
    )
    manual_pdf: Optional[bytes] = None
    try:
        cached = await should_skip(case_id, StageName.DIAGNOSE, diag_hash)
        if cached is not None:
            summary_payload = cached
            await emit(case_id, "stage_completed", {"stage": StageName.DIAGNOSE.value,
                                                    "cached": True, "output": cached})
        elif not await claim_stage(case_id, StageName.DIAGNOSE):
            await emit(case_id, "stage_skipped", {"stage": StageName.DIAGNOSE.value,
                                                  "reason": "claimed by another worker"})
            return {"case_id": case_id, "status": "claimed_elsewhere"}
        else:
            await emit(case_id, "stage_started", {"stage": StageName.DIAGNOSE.value})
            images = await _load_images(assets)
            manual_pdf = (await manuals.pdf_bytes(manual["manual_id"], manual["pdf_path"])
                          if manual else None)
            manual_url = (await storage.create_signed_download_url(manual["pdf_path"], ttl=1800)
                          if manual and settings.diagnose_manual_via_url else None)
            effort = settings.diagnose_reasoning_effort

            # Retrieval narrows what diagnose reads to the top-k manual pages.
            # Any failure or an empty result falls back to the full manual:
            # slower, never worse. Flag off makes exactly the original call.
            retrieved = None
            if settings.retrieval_enabled and manual_pdf:
                try:
                    retrieved = await retrieve_stage.run(
                        ident.manual_id, ident, case["symptom"],
                        error_code=case.get("error_code"),
                    )
                    await emit(case_id, "retrieval_completed", retrieved.as_dict())
                except Exception as e:  # noqa: BLE001
                    log.warning("retrieval failed for %s, using full manual: %s", case_id, e)
                    await emit(case_id, "retrieval_fallback", {"reason": str(e)[:300]})
            if retrieved and retrieved.pages:
                page_numbers = sorted(retrieved.pages)
                diagnose_doc = pdf.extract_pages(manual_pdf, page_numbers)
                diagnose_kwargs: dict[str, Any] = {"page_numbers": page_numbers}
            else:
                diagnose_doc = manual_pdf
                diagnose_kwargs = {"manual_url": manual_url}

            async def _diagnose():
                return await diagnose.run(
                    diagnose_doc,
                    ident,
                    case["symptom"],
                    error_code=case.get("error_code"),
                    images=images,
                    reasoning={"effort": effort} if effort else None,
                    **diagnose_kwargs,
                )

            summary, usage = await with_retry(_diagnose)
            if retrieved:
                usage = usage | {"retrieval": retrieved.as_dict()}
            summary.safety = assessment
            summary_payload = json.loads(summary.model_dump_json())
            await record_stage(
                case_id,
                StageResult(stage=StageName.DIAGNOSE, status=StageStatus.DONE,
                            output=summary_payload, usage=usage),
                input_hash=diag_hash,
            )
            await emit(case_id, "stage_completed", {"stage": StageName.DIAGNOSE.value,
                                                    "output": summary_payload, "usage": usage})
    except Exception as e:  # noqa: BLE001
        await _fail_stage(case_id, StageName.DIAGNOSE, e)
        await _set_case_status(case_id, CaseStatus.FAILED)
        return {"case_id": case_id, "status": CaseStatus.FAILED.value}

    await emit(case_id, "diagnosis_complete", {"summary": summary_payload})

    # --- verify citations, then parts and instructions -------------------
    # These stages were built after this runner, so they are appended here.
    # Neither is allowed to fail the case: a diagnosis with page citations is
    # already useful on its own, and losing it because a parts lookup errored
    # would be the worst possible trade.
    parts_payload: dict[str, Any] | None = None
    instructions_payload: dict[str, Any] | None = None

    # The cache path above only restores the stored payload, not the objects the
    # later stages take. Rebuild them here so a cached rerun still reaches parts
    # and instructions instead of failing both on an undefined name.
    summary = RepairSummary.model_validate(summary_payload)
    if manual_pdf is None and manual:
        manual_pdf = await manuals.pdf_bytes(manual["manual_id"], manual["pdf_path"])

    try:
        summary = await parts_stage.verify_summary(summary, manual_pdf)
        summary_payload = json.loads(summary.model_dump_json())
        # Verification annotates the diagnosis; it is not a new run. Touch only
        # `output` - a full record_stage here would overwrite the diagnose
        # stage's usage (tokens, cost) and completion time with blanks.
        await db.execute(
            "UPDATE stage_runs SET output=$3 WHERE case_id=$1 AND stage=$2",
            case_id, StageName.DIAGNOSE.value, summary_payload,
        )
    except Exception as e:  # noqa: BLE001
        log.warning("verification failed for %s: %s", case_id, e)

    async def _aux(stage_name: StageName, factory) -> Optional[dict[str, Any]]:
        try:
            if not await claim_stage(case_id, stage_name):
                return None
            await emit(case_id, "stage_started", {"stage": stage_name.value})
            result, usage = await with_retry(factory)
            payload = json.loads(result.model_dump_json())
            await record_stage(
                case_id,
                StageResult(stage=stage_name, status=StageStatus.DONE,
                            output=payload, usage=usage),
            )
            await emit(case_id, "stage_completed",
                       {"stage": stage_name.value, "output": payload, "usage": usage})
            return payload
        except Exception as e:  # noqa: BLE001
            await _fail_stage(case_id, stage_name, e)
            return None

    # Instructions take the diagnosis and the safety verdict, never the parts
    # list, so the two run concurrently. Each records its own outcome; the
    # frontend translator waits for both before finishing the result screen.
    parts_payload, instructions_payload = await asyncio.gather(
        _aux(StageName.PARTS, lambda: parts_stage.run(manual_pdf, ident, summary)),
        _aux(StageName.INSTRUCT,
             lambda: instruct_stage.run(manual_pdf, ident, summary, assessment)),
    )

    await _set_case_status(case_id, CaseStatus.READY)

    return {
        "case_id": case_id,
        "status": CaseStatus.READY.value,
        "identity": identity_payload,
        "summary": summary_payload,
        "parts": parts_payload,
        "instructions": instructions_payload,
    }


TERMINAL_CASE_STATUSES = {CaseStatus.READY.value, CaseStatus.FAILED.value}


async def case_is_terminal(case_id: str) -> bool:
    status = await db.fetchval("SELECT status FROM cases WHERE case_id=$1", case_id)
    return status is None or status in TERMINAL_CASE_STATUSES


async def is_running(case_id: str) -> bool:
    """True when a stage of this case holds a lease that has not gone stale."""
    return bool(
        await db.fetchval(
            f"""SELECT 1 FROM stage_runs
                 WHERE case_id=$1 AND status='running'
                   AND claimed_at > NOW() - INTERVAL '{LEASE_TIMEOUT}' LIMIT 1""",
            case_id,
        )
    )
