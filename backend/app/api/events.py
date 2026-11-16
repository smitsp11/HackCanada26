"""Async run trigger + the SSE stream that replays it.

The contract this file exists to honour: a client that loses its connection
must be able to reconnect and catch up by reading `pipeline_events` out of
Postgres. It must never re-trigger a pipeline that costs real money and 90
seconds. So `GET /events` always replays stored rows with `seq > after` first,
then tails; and `POST /run-async` refuses to start a second run while one is
already in flight.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, AsyncIterator, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from app.api.cases import require_auth
from app.core import db
from app.pipeline import runner

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/cases", tags=["events"])

# Interval between DB polls while tailing, and between keep-alive comments.
POLL_INTERVAL = 0.5
HEARTBEAT_SECONDS = 15.0
# How long to keep heartbeating after the case turns terminal before hanging up.
# EventSource treats any server-side close as an error and retries the GET with
# backoff, so closing the instant the last event lands provokes reconnects we
# do not need. Let the client hang up first.
TERMINAL_HOLD_SECONDS = 30.0

# In-process guard. The durable one is the stage lease in Postgres; this one
# just keeps a double-click from creating two tasks in the same worker.
_tasks: dict[str, asyncio.Task] = {}


async def _require_case(case_id: str) -> dict[str, Any]:
    row = await db.fetchrow("SELECT case_id, status FROM cases WHERE case_id=$1", case_id)
    if not row:
        raise HTTPException(status_code=404, detail="case not found")
    return dict(row)


# ---------------------------------------------------------------------------


@router.post("/{case_id}/run-async", status_code=202)
async def run_async(case_id: str, _: None = Depends(require_auth)) -> dict[str, Any]:
    """Kick off the pipeline in the background. Idempotent while it runs."""
    await _require_case(case_id)

    existing = _tasks.get(case_id)
    if existing is not None and not existing.done():
        return {"case_id": case_id, "status": "already_running", "started": False}
    if await runner.is_running(case_id):
        return {"case_id": case_id, "status": "already_running", "started": False}

    task = asyncio.create_task(runner.run_case(case_id), name=f"run_case:{case_id}")
    _tasks[case_id] = task

    def _done(t: asyncio.Task) -> None:
        if _tasks.get(case_id) is t:
            _tasks.pop(case_id, None)
        if not t.cancelled() and t.exception() is not None:
            log.error("run_case task for %s raised: %r", case_id, t.exception())

    task.add_done_callback(_done)
    return {
        "case_id": case_id,
        "status": "accepted",
        "started": True,
        "events_url": f"/api/cases/{case_id}/events",
    }


def _frame(event: dict[str, Any]) -> str:
    """One unnamed SSE frame: `id:` + a single-line `data:` JSON object.

    Deliberately no `event:` line. The browser's EventSource routes a named
    event to `addEventListener(name, ...)` and the consuming client only sets
    `onmessage`, so a named frame is dropped silently and the UI just hangs.
    The event kind therefore lives as the `type` string inside the JSON, which
    the client checks with `typeof parsed.type === "string"` before using it.
    """
    ts = event.get("ts")
    payload = event.get("payload") or {}
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except json.JSONDecodeError:
            payload = {"raw": payload}
    body = json.dumps(
        {
            "seq": event["seq"],
            "case_id": event["case_id"],
            "type": str(event["type"]),
            "payload": payload,
            "ts": ts.isoformat() if hasattr(ts, "isoformat") else ts,
        },
        separators=(",", ":"),
        default=str,
    )
    return f"id: {event['seq']}\ndata: {body}\n\n"


async def _stream(case_id: str, after: int, request: Optional[Request]) -> AsyncIterator[str]:
    last_seq = after
    # Opens the response immediately so proxies and browsers see a live stream
    # even when there is nothing stored yet.
    yield ": open\n\n"
    last_send = asyncio.get_event_loop().time()
    terminal_since: Optional[float] = None

    while True:
        if request is not None and await request.is_disconnected():
            return

        events = await runner.events_after(case_id, last_seq)
        for event in events:
            last_seq = event["seq"]
            yield _frame(event)
            last_send = asyncio.get_event_loop().time()

        now = asyncio.get_event_loop().time()
        if events:
            # More arrived after we thought it was over; restart the hold.
            terminal_since = None
        elif await runner.case_is_terminal(case_id):
            if terminal_since is None:
                terminal_since = now
            elif now - terminal_since >= TERMINAL_HOLD_SECONDS:
                return
        else:
            terminal_since = None

        if now - last_send >= HEARTBEAT_SECONDS:
            # A comment line, not a frame: keeps proxies from timing the
            # connection out without the client having to parse anything.
            yield ": keep-alive\n\n"
            last_send = now

        await asyncio.sleep(POLL_INTERVAL)


@router.get("/{case_id}/events")
async def stream_events(
    case_id: str,
    request: Request,
    after: int = Query(0, ge=0, description="Last seq already seen; replay resumes above it."),
    _: None = Depends(require_auth),
) -> StreamingResponse:
    """Replay every stored event with seq > after, then tail until terminal."""
    await _require_case(case_id)
    return StreamingResponse(
        _stream(case_id, after, request),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            # nginx buffers text/event-stream by default, which turns a live
            # stream into one delivery at the end.
            "X-Accel-Buffering": "no",
        },
    )
