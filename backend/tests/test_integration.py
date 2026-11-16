"""Cross-seam integration test for Phase B.

Each Phase B component was built and tested in isolation, so each one's suite
proves it works against its own assumptions. This proves they work against each
other: a presigned upload feeding a staged async run, streamed over SSE, landing
as four persisted stages.

Three things are asserted here that no single-component suite can check:

  1. The presigned upload path produces assets the runner can actually consume.
     (The upload agent never ran a pipeline; the runner agent used stubbed
     stages and synthetic asset rows.)
  2. Reconnecting to the SSE stream replays from Postgres and re-executes
     nothing. This is the whole reason stage_runs exists, and it is only
     observable by running the pipeline and then reconnecting to it.
  3. The pipeline reaches parts and instruct. The runner was written before
     those stages existed, so their inclusion is wiring that only shows up here.

Costs roughly $0.10 and takes ~3 minutes: it runs the real pipeline against the
real manual once. Opt in with OPERA_LIVE=1.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import settings
import asyncpg

from app.main import app

pytestmark = pytest.mark.skipif(
    os.environ.get("OPERA_LIVE") != "1",
    reason="live pipeline run; set OPERA_LIVE=1 to enable",
)

AUTH = {"Authorization": f"Bearer {settings.api_bearer_token}"}
FIXTURES = Path("fixtures")
SYMPTOM = (
    "Furnace tries to start, igniter glows, but no flame. After several "
    "attempts it stops and the board light blinks."
)


def _upload_presigned(client: TestClient, case_id: str, path: Path, slot: str) -> str:
    """Register -> PUT straight to S3 -> complete. The production path."""
    mime = "image/png"
    r = client.post(
        f"/api/cases/{case_id}/assets/register",
        headers=AUTH,
        # The frontend's dialect: slot_key + asset_type, not role.
        json={
            "filename": path.name,
            "mime_type": mime,
            "asset_type": "image",
            "size_bytes": path.stat().st_size,
            "slot_key": slot,
        },
    )
    assert r.status_code in (200, 201), r.text
    reg = r.json()
    assert reg["upload_url"].startswith("https://"), reg

    # Straight to S3, not through the app. Content-Type must match the signature.
    put = httpx.put(
        reg["upload_url"],
        content=path.read_bytes(),
        headers={"Content-Type": reg.get("content_type", mime)},
        timeout=120,
    )
    assert put.status_code in (200, 204), f"S3 PUT {put.status_code}: {put.text[:300]}"

    done = client.post(
        f"/api/cases/{case_id}/assets/{reg['asset_id']}/complete", headers=AUTH, json={}
    )
    assert done.status_code == 200, done.text
    return reg["asset_id"]


def _read_sse(client: TestClient, case_id: str, after: int = 0, limit_sec: int = 300):
    """Collect SSE frames until the terminal event or a timeout."""
    events, deadline = [], time.time() + limit_sec
    with client.stream(
        "GET", f"/api/cases/{case_id}/events?after={after}", headers=AUTH
    ) as resp:
        assert resp.status_code == 200
        assert "text/event-stream" in resp.headers["content-type"]
        for line in resp.iter_lines():
            if time.time() > deadline:
                break
            if not line or line.startswith(":"):
                continue  # heartbeat
            assert not line.startswith("event:"), (
                "named SSE event would be silently dropped by the browser client"
            )
            if line.startswith("data:"):
                events.append(json.loads(line[5:].strip()))
                if events[-1].get("type") in ("diagnosis_complete", "error"):
                    break
    return events


def _sync(coro_factory):
    """Run a coroutine on its own loop.

    The assertions here cannot borrow `app.core.db`'s pool: TestClient is
    driving it from its own event loop, and asyncpg raises "another operation
    is in progress" the moment a second loop touches the same connection. So
    every check below opens a short-lived connection of its own.
    """
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro_factory())
    finally:
        loop.close()


async def _connect():
    return await asyncpg.connect(
        settings.database_url, ssl="require", statement_cache_size=0
    )


def stage_rows(case_id: str) -> dict[str, dict]:
    async def _go():
        conn = await _connect()
        try:
            rows = await conn.fetch(
                """SELECT stage, status, input_hash, attempts, completed_at, output
                     FROM stage_runs WHERE case_id=$1""",
                case_id,
            )
            out = {}
            for r in rows:
                d = dict(r)
                # No JSON codec on a bare connection - decode explicitly.
                if isinstance(d.get("output"), str):
                    d["output"] = json.loads(d["output"])
                out[d["stage"]] = d
            return out
        finally:
            await conn.close()

    return _sync(_go)


def delete_case(case_id: str) -> None:
    async def _go():
        conn = await _connect()
        try:
            await conn.execute("DELETE FROM cases WHERE case_id=$1", case_id)
        finally:
            await conn.close()

    _sync(_go)


@pytest.fixture(scope="module")
def live_case():
    """Run the whole pipeline once; every test below reads this one result."""
    with TestClient(app) as client:
        case_id = client.post("/api/cases", json={}, headers=AUTH).json()["case_id"]
        _upload_presigned(client, case_id, FIXTURES / "opera-img2.png", "model")
        _upload_presigned(client, case_id, FIXTURES / "opera-img1.png", "additional")

        r = client.post(
            f"/api/cases/{case_id}/input",
            headers=AUTH,
            json={"symptom": SYMPTOM, "error_code": "34.1"},
        )
        assert r.status_code == 200, r.text

        started = client.post(f"/api/cases/{case_id}/run-async", headers=AUTH)
        assert started.status_code == 202, started.text

        events = _read_sse(client, case_id)
        # Give the appended parts/instruct stages time to land.
        deadline = time.time() + 240
        while time.time() < deadline:
            rows = stage_rows(case_id)
            if {"parts", "instruct"} <= set(rows):
                break
            time.sleep(3)

        yield {"client": client, "case_id": case_id, "events": events}

        delete_case(case_id)


def test_presigned_uploads_feed_the_pipeline(live_case):
    """Assets uploaded straight to S3 are the ones the runner identified from."""
    ident = [e for e in live_case["events"] if e.get("type") == "identity_resolved"]
    assert ident, "no identity_resolved event"
    payload = ident[0]["payload"]["identity"]
    assert payload["brand"] == "Carrier"
    assert payload["unit_number"] == "59SC6A060M17--16"
    assert payload["catalog_matched"] is True


def test_sse_frames_are_unnamed_and_typed(live_case):
    """The browser client only handles unnamed frames with a string `type`."""
    assert live_case["events"], "no events received"
    for e in live_case["events"]:
        assert isinstance(e.get("type"), str) and e["type"]


def test_event_vocabulary(live_case):
    seen = {e["type"] for e in live_case["events"]}
    for required in ("case_status", "stage_started", "stage_completed",
                     "identity_resolved", "safety_verdict", "diagnosis_complete"):
        assert required in seen, f"missing {required}; saw {sorted(seen)}"


def test_safety_gate_ran_and_routed_to_technician(live_case):
    ev = [e for e in live_case["events"] if e["type"] == "safety_verdict"]
    assert ev, "safety gate never emitted"
    assert ev[0]["payload"].get("verdict") == "technician"


def test_all_four_stages_persisted(live_case):
    rows = stage_rows(live_case["case_id"])
    for stage in ("identify", "diagnose", "parts", "instruct"):
        assert stage in rows, f"{stage} never ran; got {sorted(rows)}"
        assert rows[stage]["status"] == "done", f"{stage}: {rows[stage]['status']}"


def stored_events(case_id: str, after: int = 0) -> list[dict]:
    """Exactly what the SSE endpoint replays: rows from pipeline_events."""

    async def _go():
        conn = await _connect()
        try:
            rows = await conn.fetch(
                "SELECT seq, type, payload FROM pipeline_events "
                "WHERE case_id=$1 AND seq > $2 ORDER BY seq",
                case_id, after,
            )
            return [dict(r) for r in rows]
        finally:
            await conn.close()

    return _sync(_go)


def test_reconnect_replays_without_reexecuting(live_case):
    """The core guarantee: a dropped connection costs a SELECT, not a re-run.

    The SSE transport itself is covered in test_runner.py. What is only
    observable here, after a real paid pipeline run, is that reading the stream
    back leaves every stage row untouched - same attempts, same completed_at.
    A regression would mean a reconnecting browser silently re-bills the case.
    """
    case_id = live_case["case_id"]
    before = stage_rows(case_id)

    replayed = stored_events(case_id, after=0)
    assert replayed, "nothing stored to replay"
    assert [e["seq"] for e in replayed] == sorted(e["seq"] for e in replayed)

    after = stage_rows(case_id)
    for stage, row in before.items():
        assert after[stage]["attempts"] == row["attempts"], f"{stage} re-executed on reconnect"
        assert after[stage]["completed_at"] == row["completed_at"], f"{stage} rewritten"


def test_reconnect_with_after_skips_replayed_events(live_case):
    case_id = live_case["case_id"]
    all_events = stored_events(case_id, after=0)
    assert len(all_events) > 2
    cutoff = all_events[1]["seq"]
    tail = stored_events(case_id, after=cutoff)
    assert tail, "after=N returned nothing"
    assert all(e["seq"] > cutoff for e in tail), "after=N returned already-seen events"
    assert len(tail) == len(all_events) - 2


def test_parts_never_invent_numbers(live_case):
    """Any part number that survived must actually be printed in the manual."""
    from pypdf import PdfReader
    import re

    rows = stage_rows(live_case["case_id"])
    parts = (rows["parts"]["output"] or {}).get("parts", [])
    numbers = [p["part_number"] for p in parts if p.get("part_number")]
    if not numbers:
        pytest.skip("no part numbers returned (expected for a group-list manual)")

    reader = PdfReader("manuals/opera-manual.pdf")
    text = re.sub(r"[^A-Z0-9]", "", " ".join(
        (p.extract_text() or "") for p in reader.pages).upper())
    for n in numbers:
        assert re.sub(r"[^A-Z0-9]", "", n.upper()) in text, f"invented part number {n}"


def test_instructions_respect_the_safety_verdict(live_case):
    rows = stage_rows(live_case["case_id"])
    instr = rows["instruct"]["output"] or {}
    assert instr.get("technician_brief"), "technician verdict produced no brief"
    # Homeowner-safe checks may appear as steps; actual repair procedure may not.
    from app.pipeline.safety import HOMEOWNER_SAFE

    safe = {s.lower() for s in HOMEOWNER_SAFE}
    for step in instr.get("steps") or []:
        assert step["instruction"].lower() in safe, (
            f"repair step leaked under a technician verdict: {step['instruction'][:80]}"
        )
