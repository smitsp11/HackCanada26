"""Compatibility layer for the existing Next.js frontend.

The backend speaks a semantic, stage-oriented event vocabulary
(`stage_completed`, `identity_resolved`, ...). The frontend was written against
the old backend and speaks a different one, and it silently ignores anything it
does not recognise. This module translates between them so neither side has to
bend its model to the other, and so this layer can be deleted outright once the
UI is updated.

Three properties of the client drive everything here:

  1. It only listens for UNNAMED SSE frames (`source.onmessage`). A frame with an
     `event:` line is dropped without error.
  2. It never calls anything to start the pipeline. The old backend ran the whole
     analysis inside the SSE GET, so opening this stream must start the run.
  3. It has exactly two gates and hangs forever if either never fires:
     `parts_check_complete` is the only thing that moves it from phase 2 to
     phase 3, and `synthesis_complete` is the only thing that finishes it.
     So whatever happens upstream - a parts lookup erroring, instructions timing
     out - both are always emitted, degraded if necessary. A screen frozen on
     "analysing" is the worst possible outcome of a stage failure.

Field names are the client's, including its inconsistent casing: event-level
fields are camelCase (`slotIndex`, `makeModel`, `manualId`, `schematicUrl`).
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, AsyncIterator, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse

from app.api.cases import require_auth
from app.api import events as events_api
from app.core import db, storage
from app.pipeline import runner
from app.pipeline.safety import HOMEOWNER_SAFE

router = APIRouter(prefix="/api/cases", tags=["ui-compat"])

POLL_INTERVAL = 0.5
HEARTBEAT_SECONDS = 15
# The client closes the EventSource itself on synthesis_complete/error, so this
# is only a backstop for a client that doesn't.
CLOSE_AFTER_TERMINAL_SECONDS = 10
# Long enough to cover a slow diagnosis session; these are display URLs.
SLOT_URL_TTL = 3600

# The client's slots are positional: 0 and 1 render as <img>, 2 as <video>.
ROLE_TO_SLOT = {"nameplate": 0, "interior": 1, "video": 2}

# Honest progress: fraction of stages actually finished, not a timer.
STAGE_PROGRESS = {"identify": 20, "diagnose": 60, "parts": 80, "instruct": 95}


def _pages(pages: list[int] | None) -> str:
    pages = sorted(set(pages or []))
    if not pages:
        return ""
    return f" (manual p.{', '.join(str(p) for p in pages)})"


def _make_model(identity: dict[str, Any]) -> str:
    unit = identity.get("unit_number") or identity.get("model_number")
    parts = [identity.get("brand"), unit]
    label = " ".join(p for p in parts if p)
    return label or (identity.get("appliance_type") or "Unidentified appliance")


# ---------------------------------------------------------------------------
# Translation
# ---------------------------------------------------------------------------


class UiTranslator:
    """Maps internal pipeline events onto the client's vocabulary.

    Stateful so that it can guarantee the two gate events fire exactly once and
    can synthesise them from whatever survived when a later stage fails.
    """

    def __init__(self, manual_titles: Optional[dict[str, str]] = None):
        self.manual_titles = manual_titles or {}
        self.identity: dict[str, Any] = {}
        self.summary: dict[str, Any] = {}
        self.safety: dict[str, Any] = {}
        self.parts: Optional[dict[str, Any]] = None
        self.instructions: Optional[dict[str, Any]] = None
        self.sent_analyzing = False
        self.sent_parts_gate = False
        self.sent_synthesis = False
        self.sent_error = False
        # Parts and instructions run concurrently; the result screen is only
        # built once both have settled, or the parts gate would fire with a
        # fallback before the real parts list arrived.
        self.parts_settled = False
        self.instruct_settled = False

    @property
    def finished(self) -> bool:
        return self.sent_synthesis or self.sent_error

    def feed(self, event: dict[str, Any]) -> list[dict[str, Any]]:
        etype = event.get("type")
        payload = event.get("payload") or {}
        out: list[dict[str, Any]] = []

        if etype == "case_status":
            status = payload.get("status")
            if status == "processing" and not self.sent_analyzing:
                # The client advances phase 1 -> 2 on exactly this string.
                self.sent_analyzing = True
                out.append({"type": "case_status", "status": "analyzing"})

        elif etype == "stage_started":
            stage = payload.get("stage")
            label = {
                "identify": "IDENTIFY: reading the data plate",
                "diagnose": "DIAGNOSE: reasoning over the service manual",
                "parts": "PARTS: checking the manual's parts list",
                "instruct": "INSTRUCT: building your repair guidance",
            }.get(stage)
            if label:
                out.append({"type": "synthesis_progress",
                            "percent": max(0, STAGE_PROGRESS.get(stage, 0) - 15),
                            "log": label})

        elif etype == "identity_resolved":
            self.identity = payload.get("identity") or {}
            out.append({"type": "device_identified", "makeModel": _make_model(self.identity)})
            manual_id = self.identity.get("manual_id")
            if manual_id:
                out.append({"type": "manual_found", "manualId": manual_id,
                            "title": self.manual_titles.get(manual_id) or manual_id})
            level = self.identity.get("identity_level")
            if level:
                out.append({"type": "synthesis_progress", "percent": STAGE_PROGRESS["identify"],
                            "log": f"IDENTITY: {_make_model(self.identity)} [{level}]"})

        elif etype == "safety_verdict":
            self.safety = payload or {}
            verdict = str(self.safety.get("verdict", "")).upper()
            hazards = ", ".join(self.safety.get("hazards") or []) or "none"
            out.append({"type": "synthesis_progress", "percent": STAGE_PROGRESS["identify"],
                        "log": f"SAFETY_GATE: {verdict} ({hazards})"})

        elif etype == "diagnosis_complete":
            self.summary = payload.get("summary") or {}
            out.append(self._symptom_sections())
            out.append({"type": "synthesis_progress", "percent": STAGE_PROGRESS["diagnose"],
                        "log": f"DIAGNOSE: {len(self.summary.get('causes') or [])} ranked causes"})

        elif etype == "stage_completed":
            stage = payload.get("stage")
            output = payload.get("output") or {}
            if stage == "parts":
                self.parts = output
                self.parts_settled = True
            elif stage == "instruct":
                self.instructions = output
                self.instruct_settled = True
            out += self._maybe_finish()

        elif etype == "error":
            # Only a failure before diagnosis is fatal. Parts or instructions
            # failing degrades the answer; it must not blank the screen.
            stage = payload.get("stage")
            if stage in (None, "identify", "diagnose") and not self.summary:
                out += self._fail(payload.get("error") or "The analysis failed.")
            elif stage == "parts":
                self.parts_settled = True
                out += self._maybe_finish()
            elif stage == "instruct":
                self.instruct_settled = True
                out += self._maybe_finish()

        return out

    def finalize(self, case_status: Optional[str]) -> list[dict[str, Any]]:
        """Called once the case is terminal. Guarantees the client can exit."""
        if self.finished:
            return []
        if case_status == "failed" and not self.summary:
            return self._fail("The analysis could not be completed.")
        return self._parts_gate() + self._synthesis()

    def _maybe_finish(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        if self.parts_settled:
            out += self._parts_gate()
        if self.parts_settled and self.instruct_settled:
            out += self._synthesis()
        return out

    # -- builders ---------------------------------------------------------

    def _symptom_sections(self) -> dict[str, Any]:
        causes = self.summary.get("causes") or []
        if self.summary.get("abstained") or not causes:
            sections = self.summary.get("abstain_reason") or "Not enough evidence for a confident diagnosis."
        else:
            sections = " · ".join(
                f"{c['summary']}{_pages(c.get('manual_pages'))}" for c in causes[:3]
            )
        return {"type": "symptom_sections_found",
                "symptom": self.summary.get("symptom_restated") or "",
                "sections": sections}

    def _parts_gate(self) -> list[dict[str, Any]]:
        if self.sent_parts_gate:
            return []
        self.sent_parts_gate = True

        parts = (self.parts or {}).get("parts") or []
        if parts:
            text = " · ".join(
                f"{p['name']}"
                + (f" [{p['part_number']}]" if p.get("part_number") else "")
                + _pages(p.get("manual_pages"))
                for p in parts
            )
            if (self.parts or {}).get("numbers_unavailable"):
                text += " — part numbers are not printed in this manual"
        else:
            implicated = sorted({comp for c in (self.summary.get("causes") or [])
                                 for comp in (c.get("components") or [])})
            text = ", ".join(implicated) if implicated else "No specific parts identified"
        return [
            {"type": "parts_check_complete", "parts": text},
            {"type": "synthesis_progress", "percent": STAGE_PROGRESS["parts"],
             "log": "PARTS_CHECK: complete"},
        ]

    def _synthesis(self) -> list[dict[str, Any]]:
        if self.sent_synthesis:
            return []
        self.sent_synthesis = True
        steps = self._steps()
        return [
            {"type": "synthesis_progress", "percent": 100, "log": "SYNTHESIS: complete"},
            {"type": "case_status", "status": "ready_for_analysis"},
            {"type": "synthesis_complete", "steps": steps},
        ]

    def _fail(self, message: str) -> list[dict[str, Any]]:
        self.sent_error = True
        return [{"type": "error", "message": message}]

    def _steps(self) -> list[dict[str, Any]]:
        """Flatten our structured output into the client's {id, instruction, schematicUrl}.

        The client has no field for citations, so page references are folded
        into the instruction text - otherwise the grounding, which is the whole
        point of this product, would be invisible.
        """
        instructions: list[str] = []
        verdict = str(self.safety.get("verdict", "")).lower()
        instr = self.instructions or {}

        if verdict == "technician":
            reasons = " ".join(self.safety.get("reasons") or [])
            line = f"This repair needs a licensed technician. {reasons}".strip()
            scope = self.safety.get("manual_scope_note")
            if scope:
                line += f' The manufacturer states: "{scope.strip()}"{_pages(self.safety.get("manual_pages"))}'
            instructions.append(line)

        causes = self.summary.get("causes") or []
        if self.summary.get("abstained"):
            reason = self.summary.get("abstain_reason") or "the evidence was not conclusive"
            instructions.append(f"No confident diagnosis: {reason.strip()}")
        elif causes:
            # What is wrong leads; the checks and the brief follow it. Otherwise
            # the one specific finding sits at the bottom under generic steps.
            top = causes[0]
            instructions.append(f"Most likely cause: {top['summary']}{_pages(top.get('manual_pages'))}")

        steps = instr.get("steps") or []
        if steps:
            for s in steps:
                text = s.get("instruction", "").strip()
                if s.get("caution"):
                    text += f" Caution: {s['caution'].strip()}"
                instructions.append(text + _pages(s.get("manual_pages")))
        elif verdict == "technician":
            instructions += [f"{c}." for c in HOMEOWNER_SAFE]

        brief = instr.get("technician_brief")
        if brief:
            instructions.append(f"Tell your technician: {brief.strip()}")

        if self.instructions is None:
            # Instructions never arrived. Without this the result screen - the
            # only one that persists - would say "call a technician" and list
            # generic checks without ever saying what is actually wrong; the
            # diagnosis would have flashed past in phase 2 and been lost.
            for c in causes[1:3]:
                instructions.append(f"Other possible cause: {c['summary']}{_pages(c.get('manual_pages'))}")

        if not instructions:
            instructions = ["No repair guidance could be produced for this case."]

        return [{"id": i, "instruction": text, "schematicUrl": None}
                for i, text in enumerate(instructions, start=1)]


# ---------------------------------------------------------------------------
# Stream
# ---------------------------------------------------------------------------


def _frame(obj: dict[str, Any]) -> str:
    # Unnamed frame, compact single-line JSON with a string `type`.
    return f"data: {json.dumps(obj, separators=(',', ':'), default=str)}\n\n"


async def _slot_events(case_id: str) -> list[dict[str, Any]]:
    rows = await db.fetch(
        "SELECT asset_id, role, storage_key_raw, status FROM assets "
        "WHERE case_id=$1 AND status IN ('uploaded','ready') ORDER BY created_at",
        case_id,
    )
    taken: dict[int, dict[str, Any]] = {}
    spill = []
    for r in rows:
        slot = ROLE_TO_SLOT.get(r["role"])
        if slot is not None and slot not in taken:
            taken[slot] = dict(r)
        else:
            spill.append(dict(r))
    for r in spill:
        free = next((i for i in (0, 1) if i not in taken), None)
        if free is not None:
            taken[free] = r

    out = []
    for slot in sorted(taken):
        key = taken[slot]["storage_key_raw"]
        url = await storage.create_signed_download_url(key, ttl=SLOT_URL_TTL) if key else None
        out.append({"type": "slot_processing", "slotIndex": slot})
        out.append({"type": "slot_complete", "slotIndex": slot, "url": url or ""})
    return out


async def _start_if_needed(case_id: str, case: dict[str, Any]) -> None:
    """Start the pipeline unless it has already run or is running.

    Shares the in-process task registry with POST /run-async, so a UI connect
    and an explicit trigger can never double-start the same case.
    """
    if case["status"] in ("processing", "ready", "failed"):
        return
    if case_id in events_api._tasks or await runner.is_running(case_id):
        return
    task = asyncio.create_task(runner.run_case(case_id), name=f"run_case:{case_id}")
    events_api._tasks[case_id] = task
    task.add_done_callback(lambda t: events_api._tasks.pop(case_id, None)
                           if events_api._tasks.get(case_id) is t else None)


async def _ui_stream(case_id: str, request: Request) -> AsyncIterator[str]:
    yield ": open\n\n"

    case = await db.fetchrow("SELECT * FROM cases WHERE case_id=$1", case_id)
    if not case:
        yield _frame({"type": "error", "message": "Case not found."})
        return
    case = dict(case)

    if not case.get("symptom"):
        yield _frame({"type": "error",
                      "message": "No symptom was submitted for this case."})
        return

    for ev in await _slot_events(case_id):
        yield _frame(ev)

    titles = {r["manual_id"]: r["title"]
              for r in await db.fetch("SELECT manual_id, title FROM manuals")}
    translator = UiTranslator(manual_titles=titles)

    await _start_if_needed(case_id, case)

    loop = asyncio.get_event_loop()
    last_seq, last_send = 0, loop.time()
    terminal_since: Optional[float] = None

    while True:
        if await request.is_disconnected():
            return

        for event in await runner.events_after(case_id, last_seq):
            last_seq = event["seq"]
            for ui in translator.feed(event):
                yield _frame(ui)
                last_send = loop.time()

        if not translator.finished and await runner.case_is_terminal(case_id):
            status = await db.fetchval("SELECT status FROM cases WHERE case_id=$1", case_id)
            # One more sweep: events can land between the read and the check.
            for event in await runner.events_after(case_id, last_seq):
                last_seq = event["seq"]
                for ui in translator.feed(event):
                    yield _frame(ui)
            for ui in translator.finalize(status):
                yield _frame(ui)
            last_send = loop.time()

        now = loop.time()
        if translator.finished:
            terminal_since = terminal_since or now
            if now - terminal_since >= CLOSE_AFTER_TERMINAL_SECONDS:
                return

        if now - last_send >= HEARTBEAT_SECONDS:
            yield ": keep-alive\n\n"
            last_send = now

        await asyncio.sleep(POLL_INTERVAL)


@router.get("/{case_id}/ui-events")
async def ui_events(case_id: str, request: Request, _: None = Depends(require_auth)):
    """The frontend's event stream. Opening it starts the pipeline."""
    exists = await db.fetchval("SELECT 1 FROM cases WHERE case_id=$1", case_id)
    if not exists:
        raise HTTPException(status_code=404, detail="case not found")
    return StreamingResponse(
        _ui_stream(case_id, request),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
