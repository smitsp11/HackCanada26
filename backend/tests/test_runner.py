"""Tests for the staged runner and the SSE replay endpoint.

    ./.venv/bin/python -m pytest tests/test_runner.py -v

These hit a real Postgres (the runner is mostly SQL semantics - an atomic
UPDATE lease, a UNIQUE(case_id,seq) race - and mocking them would only test the
mock). They never hit OpenRouter or S3: fixture rows go in with db.execute, so
the whole file runs in seconds and costs nothing, unlike the ~$0.07/90s a live
pipeline run costs.
"""

from __future__ import annotations

import asyncio
import json
import uuid

import httpx
import pytest
import pytest_asyncio
from fastapi import FastAPI

from app.api import events as events_api
from app.config import settings
from app.core import db
from app.pipeline import runner
from app.schemas.contracts import (
    ApplianceIdentity,
    CaseStatus,
    RepairSummary,
    StageName,
    StageResult,
    StageStatus,
)

pytestmark = pytest.mark.asyncio(loop_scope="session")


@pytest_asyncio.fixture(scope="session", loop_scope="session", autouse=True)
async def _pool():
    if not settings.database_url:
        pytest.skip("DATABASE_URL not set")
    await _reset_pool()
    await db.init_pool()
    yield
    await _reset_pool()


async def _reset_pool() -> None:
    """Drop whatever pool is installed, from whichever loop created it.

    A pool only works on its creating loop, so a pool another test module left
    behind is unusable here. Orphaning it is not an option either: its sockets
    stay open against the connection pooler, and a second pool on top of them
    trips the server's client limit rather than failing locally.
    """
    existing = getattr(db, "_pool", None)
    if existing is None:
        return
    try:
        await db.close_pool()
    except Exception:
        try:
            existing.terminate()
        except Exception:
            pass
        db._pool = None


@pytest_asyncio.fixture(loop_scope="session")
async def case_id() -> str:
    cid = f"case_test_{uuid.uuid4().hex[:12]}"
    await db.execute(
        "INSERT INTO cases (case_id, status, symptom) VALUES ($1,$2,$3)",
        cid, CaseStatus.PROCESSING.value, "furnace will not ignite",
    )
    yield cid
    # ON DELETE CASCADE clears stage_runs and pipeline_events with it.
    await db.execute("DELETE FROM cases WHERE case_id=$1", cid)


async def _insert_stage(case_id: str, stage: StageName, **cols) -> None:
    await db.execute(
        """INSERT INTO stage_runs (stage_run_id, case_id, stage, status, input_hash,
                                   output, claimed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (case_id, stage) DO UPDATE SET
             status=EXCLUDED.status, input_hash=EXCLUDED.input_hash,
             output=EXCLUDED.output, claimed_at=EXCLUDED.claimed_at""",
        f"sr_{uuid.uuid4().hex[:12]}", case_id, stage.value,
        cols.get("status", "queued"), cols.get("input_hash"),
        cols.get("output"), cols.get("claimed_at"),
    )


# ---------------------------------------------------------------------------
# compute_input_hash
# ---------------------------------------------------------------------------


async def test_input_hash_is_deterministic():
    kwargs = dict(
        symptom="no heat",
        error_code="34.1",
        assets=[{"asset_id": "a2", "checksum": "sha2"}, {"asset_id": "a1", "checksum": "sha1"}],
        manual_id="carrier-59sc6a",
        model="google/gemini-2.5-pro",
    )
    a = runner.compute_input_hash(StageName.DIAGNOSE, **kwargs)
    b = runner.compute_input_hash(StageName.DIAGNOSE, **kwargs)
    assert a == b
    assert len(a) == 64


async def test_input_hash_ignores_asset_order_and_identity_of_dicts():
    one = runner.compute_input_hash(
        StageName.IDENTIFY,
        assets=[{"asset_id": "a1", "checksum": "sha1"}, {"asset_id": "a2", "checksum": "sha2"}],
    )
    two = runner.compute_input_hash(
        StageName.IDENTIFY,
        # Same content, reversed, and an id that differs - the checksum decides.
        assets=[{"asset_id": "zzz", "checksum": "sha2"}, {"asset_id": "a1", "checksum": "sha1"}],
    )
    assert one == two


async def test_input_hash_changes_when_a_real_input_changes():
    base = runner.compute_input_hash(StageName.DIAGNOSE, symptom="no heat", manual_id="m1")
    assert base != runner.compute_input_hash(
        StageName.DIAGNOSE, symptom="no heat at all", manual_id="m1"
    )
    assert base != runner.compute_input_hash(StageName.DIAGNOSE, symptom="no heat", manual_id="m2")
    assert base != runner.compute_input_hash(
        StageName.DIAGNOSE, symptom="no heat", manual_id="m1", error_code="34.1"
    )
    # Stage is part of the key: two stages must never share a cache entry.
    assert base != runner.compute_input_hash(
        StageName.IDENTIFY, symptom="no heat", manual_id="m1"
    )


# ---------------------------------------------------------------------------
# claim_stage
# ---------------------------------------------------------------------------


async def test_claim_stage_is_won_exactly_once(case_id):
    assert await runner.claim_stage(case_id, StageName.IDENTIFY) is True
    assert await runner.claim_stage(case_id, StageName.IDENTIFY) is False

    row = await db.fetchrow(
        "SELECT status, claimed_at, attempts FROM stage_runs WHERE case_id=$1 AND stage=$2",
        case_id, StageName.IDENTIFY.value,
    )
    assert row["status"] == "running"
    assert row["claimed_at"] is not None
    assert row["attempts"] == 1


async def test_only_one_of_many_concurrent_claimers_wins(case_id):
    results = await asyncio.gather(
        *(runner.claim_stage(case_id, StageName.DIAGNOSE) for _ in range(8))
    )
    assert sum(results) == 1, results


async def test_stale_lease_is_reclaimable(case_id):
    """A worker killed mid-stage must not strand the row in 'running' forever."""
    await runner.claim_stage(case_id, StageName.IDENTIFY)
    assert await runner.claim_stage(case_id, StageName.IDENTIFY) is False

    await db.execute(
        "UPDATE stage_runs SET claimed_at = NOW() - INTERVAL '20 minutes' "
        "WHERE case_id=$1 AND stage=$2",
        case_id, StageName.IDENTIFY.value,
    )
    assert await runner.claim_stage(case_id, StageName.IDENTIFY) is True
    assert await db.fetchval(
        "SELECT attempts FROM stage_runs WHERE case_id=$1 AND stage=$2",
        case_id, StageName.IDENTIFY.value,
    ) == 2


async def test_fresh_lease_is_not_reclaimable(case_id):
    await runner.claim_stage(case_id, StageName.IDENTIFY)
    await db.execute(
        "UPDATE stage_runs SET claimed_at = NOW() - INTERVAL '2 minutes' "
        "WHERE case_id=$1 AND stage=$2",
        case_id, StageName.IDENTIFY.value,
    )
    assert await runner.claim_stage(case_id, StageName.IDENTIFY) is False


async def test_done_stage_is_never_reclaimed(case_id):
    await _insert_stage(case_id, StageName.IDENTIFY, status="done", input_hash="h", output={})
    assert await runner.claim_stage(case_id, StageName.IDENTIFY) is False


# ---------------------------------------------------------------------------
# should_skip
# ---------------------------------------------------------------------------


async def test_should_skip_returns_stored_output_on_matching_hash(case_id):
    stored = {"brand": "Carrier", "manual_id": "carrier-59sc6a", "confidence": 0.9}
    await _insert_stage(
        case_id, StageName.IDENTIFY, status="done", input_hash="hash_a", output=stored
    )
    assert await runner.should_skip(case_id, StageName.IDENTIFY, "hash_a") == stored


async def test_should_skip_returns_none_on_a_different_hash(case_id):
    await _insert_stage(
        case_id, StageName.IDENTIFY, status="done", input_hash="hash_a", output={"brand": "X"}
    )
    assert await runner.should_skip(case_id, StageName.IDENTIFY, "hash_b") is None


async def test_should_skip_ignores_unfinished_and_failed_rows(case_id):
    await _insert_stage(
        case_id, StageName.DIAGNOSE, status="failed", input_hash="hash_a", output={"partial": 1}
    )
    assert await runner.should_skip(case_id, StageName.DIAGNOSE, "hash_a") is None

    await _insert_stage(
        case_id, StageName.DIAGNOSE, status="running", input_hash="hash_a", output={"partial": 1}
    )
    assert await runner.should_skip(case_id, StageName.DIAGNOSE, "hash_a") is None


async def test_record_stage_then_should_skip_round_trips(case_id):
    h = runner.compute_input_hash(StageName.DIAGNOSE, symptom="no heat")
    payload = {"symptom_restated": "no heat", "causes": [{"summary": "igniter"}]}
    await runner.record_stage(
        case_id,
        StageResult(stage=StageName.DIAGNOSE, status=StageStatus.DONE, output=payload,
                    usage={"cost": 0.07}),
        input_hash=h,
    )
    assert await runner.should_skip(case_id, StageName.DIAGNOSE, h) == payload
    # A completed stage releases its lease, or nothing else could ever claim it.
    assert await db.fetchval(
        "SELECT claimed_at FROM stage_runs WHERE case_id=$1 AND stage=$2",
        case_id, StageName.DIAGNOSE.value,
    ) is None


# ---------------------------------------------------------------------------
# emit
# ---------------------------------------------------------------------------


async def test_emit_assigns_sequential_seq(case_id):
    assert await runner.emit(case_id, "case_status", {"status": "processing"}) == 1
    assert await runner.emit(case_id, "stage_started", {"stage": "identify"}) == 2
    rows = await runner.events_after(case_id, 0)
    assert [r["type"] for r in rows] == ["case_status", "stage_started"]
    assert rows[0]["payload"] == {"status": "processing"}


async def test_emit_is_gapless_under_concurrency(case_id):
    seqs = await asyncio.gather(
        *(runner.emit(case_id, "tick", {"i": i}) for i in range(20))
    )
    assert sorted(seqs) == list(range(1, 21)), seqs

    stored = [r["seq"] for r in await runner.events_after(case_id, 0)]
    assert stored == list(range(1, 21))
    # Every payload survived: no writer lost its row to the race.
    payloads = {r["payload"]["i"] for r in await runner.events_after(case_id, 0)}
    assert payloads == set(range(20))


async def test_events_after_filters_by_seq(case_id):
    for i in range(5):
        await runner.emit(case_id, "tick", {"i": i})
    rows = await runner.events_after(case_id, 3)
    assert [r["seq"] for r in rows] == [4, 5]


# ---------------------------------------------------------------------------
# retry classification
# ---------------------------------------------------------------------------


async def test_transient_failure_is_retried_then_succeeds(monkeypatch):
    monkeypatch.setattr(runner, "RETRY_BASE_DELAY", 0.001)
    calls = {"n": 0}

    async def flaky():
        calls["n"] += 1
        if calls["n"] < 3:
            raise RuntimeError("openrouter 503: upstream unavailable")
        return "ok"

    assert await runner.with_retry(flaky) == "ok"
    assert calls["n"] == 3


async def test_transient_failure_gives_up_after_three_attempts(monkeypatch):
    monkeypatch.setattr(runner, "RETRY_BASE_DELAY", 0.001)
    calls = {"n": 0}

    async def always_fails():
        calls["n"] += 1
        raise RuntimeError("openrouter 502: bad gateway")

    with pytest.raises(RuntimeError):
        await runner.with_retry(always_fails)
    assert calls["n"] == runner.MAX_ATTEMPTS


async def test_permanent_failure_is_not_retried(monkeypatch):
    monkeypatch.setattr(runner, "RETRY_BASE_DELAY", 0.001)
    for exc in (
        RuntimeError("openrouter 400: invalid request"),
        ValueError("schema validation failed"),
        runner.PermanentStageError("no symptom"),
    ):
        calls = {"n": 0}

        async def fails(e=exc):
            calls["n"] += 1
            raise e

        with pytest.raises(type(exc)):
            await runner.with_retry(fails)
        assert calls["n"] == 1, f"{exc!r} should not have been retried"


async def test_rate_limit_is_treated_as_transient():
    assert runner.is_permanent(RuntimeError("openrouter 429: rate limited")) is False
    assert runner.is_permanent(RuntimeError("openrouter 401: bad key")) is True


# ---------------------------------------------------------------------------
# run_case guards (no model calls)
# ---------------------------------------------------------------------------


async def test_run_case_without_a_symptom_fails_loudly_and_does_not_raise():
    cid = f"case_test_{uuid.uuid4().hex[:12]}"
    await db.execute("INSERT INTO cases (case_id, status) VALUES ($1,'created')", cid)
    try:
        result = await runner.run_case(cid)
        assert result["status"] == CaseStatus.FAILED.value
        types = [e["type"] for e in await runner.events_after(cid, 0)]
        assert "error" in types and "case_status" in types
        assert await db.fetchval("SELECT status FROM cases WHERE case_id=$1", cid) == "failed"
    finally:
        await db.execute("DELETE FROM cases WHERE case_id=$1", cid)


async def test_run_case_on_a_missing_case_returns_rather_than_raising():
    assert (await runner.run_case("case_does_not_exist"))["status"] == "not_found"


async def test_run_case_orchestration_emits_the_full_event_contract(case_id, monkeypatch):
    """The real stage functions are stubbed - a live run costs ~$0.07 and 90s.

    What is under test is the orchestration: claim, persist, emit, cache.
    """
    calls = {"identify": 0, "diagnose": 0}

    async def fake_identify(images, *, brand_hint=None, model_hint=None):
        calls["identify"] += 1
        return ApplianceIdentity(brand="Carrier", model_number="59SC6A",
                                 appliance_type="furnace", confidence=0.9), {"cost": 0.01}

    async def fake_diagnose(manual_pdf, identity, symptom, *, error_code=None, images=None, **_):
        calls["diagnose"] += 1
        return RepairSummary(symptom_restated=symptom, causes=[]), {"cost": 0.06}

    monkeypatch.setattr("app.pipeline.stages.identify.run", fake_identify)
    monkeypatch.setattr("app.pipeline.stages.diagnose.run", fake_diagnose)

    result = await runner.run_case(case_id)
    assert result["status"] == CaseStatus.READY.value

    types = [e["type"] for e in await runner.events_after(case_id, 0)]
    for required in ("case_status", "stage_started", "stage_completed",
                     "identity_resolved", "safety_verdict", "diagnosis_complete"):
        assert required in types, f"missing {required} event: {types}"
    assert types[0] == "case_status" and types[-1] == "case_status"

    rows = {r["stage"]: r for r in await db.fetch(
        "SELECT stage, status, input_hash, output FROM stage_runs WHERE case_id=$1", case_id)}
    assert rows["identify"]["status"] == "done" and rows["diagnose"]["status"] == "done"
    assert rows["identify"]["input_hash"] and rows["diagnose"]["input_hash"]
    # An unidentified appliance must still get a verdict, and it must be cautious.
    verdict = next(e for e in await runner.events_after(case_id, 0)
                   if e["type"] == "safety_verdict")
    assert verdict["payload"]["verdict"] == "technician"

    # Re-running with identical inputs must reuse the stored output, not repay.
    await runner.run_case(case_id)
    assert calls == {"identify": 1, "diagnose": 1}


async def test_run_case_records_a_stage_failure_instead_of_dying(case_id, monkeypatch):
    monkeypatch.setattr(runner, "RETRY_BASE_DELAY", 0.001)

    async def boom(images, *, brand_hint=None, model_hint=None):
        raise RuntimeError("openrouter 400: malformed image")

    monkeypatch.setattr("app.pipeline.stages.identify.run", boom)

    result = await runner.run_case(case_id)
    assert result["status"] == CaseStatus.FAILED.value

    row = await db.fetchrow(
        "SELECT status, error, claimed_at FROM stage_runs WHERE case_id=$1 AND stage='identify'",
        case_id,
    )
    assert row["status"] == "failed"
    assert "malformed image" in row["error"]
    assert row["claimed_at"] is None, "a failed stage must release its lease"

    err = next(e for e in await runner.events_after(case_id, 0) if e["type"] == "error")
    assert err["payload"]["stage"] == "identify" and err["payload"]["permanent"] is True
    assert await db.fetchval("SELECT status FROM cases WHERE case_id=$1", case_id) == "failed"


# ---------------------------------------------------------------------------
# SSE replay
# ---------------------------------------------------------------------------


def _parse_sse(text: str) -> list[dict]:
    """Parse frames the way a browser EventSource with only `onmessage` would.

    Asserts the two things that silently break that client: a named event
    (`event:` line) is routed to a listener it never registers, and a payload
    whose `type` is not a string is discarded after JSON.parse.
    """
    out = []
    for block in text.split("\n\n"):
        lines = block.splitlines()
        assert not any(ln.startswith("event:") for ln in lines), (
            f"named SSE event would be dropped by onmessage-only clients: {block!r}"
        )
        data = [ln[6:] for ln in lines if ln.startswith("data: ")]
        ids = [ln[4:] for ln in lines if ln.startswith("id: ")]
        if not data:
            continue
        assert len(data) == 1, "data: must be one single-line JSON object per frame"
        event = json.loads(data[0])
        assert isinstance(event, dict), "each frame must be a JSON object"
        assert isinstance(event.get("type"), str), "frame needs a string `type` field"
        assert ids and int(ids[0]) == event["seq"], "id: line must carry the seq"
        out.append(event)
    return out


@pytest.fixture
def fast_stream(monkeypatch):
    """Same behaviour, compressed timings, so the suite stays seconds long."""
    monkeypatch.setattr(events_api, "TERMINAL_HOLD_SECONDS", 1.5)
    monkeypatch.setattr(events_api, "HEARTBEAT_SECONDS", 0.4)
    monkeypatch.setattr(events_api, "POLL_INTERVAL", 0.05)


def _app() -> FastAPI:
    app = FastAPI()
    app.include_router(events_api.router)
    return app


def _headers() -> dict:
    return (
        {"Authorization": f"Bearer {settings.api_bearer_token}"}
        if settings.api_bearer_token
        else {}
    )


async def _read_stream(case_id: str, after: int) -> str:
    transport = httpx.ASGITransport(app=_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as client:
        async with client.stream(
            "GET", f"/api/cases/{case_id}/events?after={after}", headers=_headers()
        ) as resp:
            assert resp.status_code == 200
            assert resp.headers["content-type"].startswith("text/event-stream")
            assert resp.headers["cache-control"] == "no-cache, no-transform"
            assert resp.headers["x-accel-buffering"] == "no"
            chunks = [c async for c in resp.aiter_text()]
    return "".join(chunks)


async def test_sse_replays_stored_events_in_order(case_id, fast_stream):
    for i in range(6):
        await runner.emit(case_id, "tick", {"i": i})
    # Terminal status is what lets the stream close instead of tailing forever.
    await db.execute("UPDATE cases SET status='ready' WHERE case_id=$1", case_id)

    body = await asyncio.wait_for(_read_stream(case_id, 0), timeout=20)
    got = _parse_sse(body)
    assert [e["seq"] for e in got] == [1, 2, 3, 4, 5, 6]
    assert [e["payload"]["i"] for e in got] == list(range(6))
    assert all(e["case_id"] == case_id for e in got)


async def test_sse_after_n_replays_only_later_events(case_id, fast_stream):
    for i in range(6):
        await runner.emit(case_id, "tick", {"i": i})
    await db.execute("UPDATE cases SET status='ready' WHERE case_id=$1", case_id)

    body = await asyncio.wait_for(_read_stream(case_id, 4), timeout=20)
    got = _parse_sse(body)
    assert [e["seq"] for e in got] == [5, 6], "reconnect must resume above `after`, not replay all"


async def test_sse_replay_does_not_touch_stage_runs(case_id, fast_stream):
    """The whole point: reconnecting reads rows, it never re-runs a paid stage."""
    await runner.emit(case_id, "case_status", {"status": "ready"})
    await _insert_stage(
        case_id, StageName.DIAGNOSE, status="done", input_hash="h", output={"causes": []}
    )
    await db.execute("UPDATE cases SET status='ready' WHERE case_id=$1", case_id)

    before = await db.fetch("SELECT stage, status, attempts FROM stage_runs WHERE case_id=$1",
                            case_id)
    await asyncio.wait_for(_read_stream(case_id, 0), timeout=20)
    after = await db.fetch("SELECT stage, status, attempts FROM stage_runs WHERE case_id=$1",
                           case_id)
    assert [dict(r) for r in before] == [dict(r) for r in after]


async def test_sse_holds_the_connection_open_after_the_terminal_event(case_id, fast_stream):
    """EventSource treats a server-side close as an error and retries the GET.

    Closing the moment the last event lands would therefore provoke a reconnect
    storm on every finished case, so the stream keeps heartbeating instead.
    """
    await runner.emit(case_id, "case_status", {"status": "ready"})
    await db.execute("UPDATE cases SET status='ready' WHERE case_id=$1", case_id)

    loop = asyncio.get_event_loop()
    started = loop.time()
    body = await asyncio.wait_for(_read_stream(case_id, 0), timeout=20)
    elapsed = loop.time() - started

    assert elapsed >= events_api.TERMINAL_HOLD_SECONDS, "stream closed eagerly"
    tail = body.split("data: ", 1)[1]
    assert ": keep-alive" in tail, "expected heartbeats after the terminal event"


async def test_sse_on_a_missing_case_is_404():
    transport = httpx.ASGITransport(app=_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as client:
        r = await client.get("/api/cases/case_nope/events", headers=_headers())
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# run-async idempotency
# ---------------------------------------------------------------------------


async def test_run_async_does_not_start_a_second_run_while_one_holds_a_lease(case_id):
    """A fresh lease in Postgres is what stops a double-click paying twice."""
    await runner.claim_stage(case_id, StageName.IDENTIFY)
    assert await runner.is_running(case_id) is True

    transport = httpx.ASGITransport(app=_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as client:
        r = await client.post(f"/api/cases/{case_id}/run-async", headers=_headers())
    assert r.status_code == 202
    assert r.json() == {"case_id": case_id, "status": "already_running", "started": False}
    assert case_id not in events_api._tasks


async def test_run_async_is_idempotent_against_its_own_in_flight_task(case_id, monkeypatch):
    started = asyncio.Event()
    release = asyncio.Event()
    calls = {"n": 0}

    async def fake_run_case(cid: str):
        calls["n"] += 1
        started.set()
        await release.wait()
        return {"case_id": cid, "status": "ready"}

    monkeypatch.setattr(runner, "run_case", fake_run_case)

    transport = httpx.ASGITransport(app=_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as client:
        first = await client.post(f"/api/cases/{case_id}/run-async", headers=_headers())
        await asyncio.wait_for(started.wait(), timeout=5)
        second = await client.post(f"/api/cases/{case_id}/run-async", headers=_headers())

    assert first.status_code == 202 and first.json()["started"] is True
    assert second.status_code == 202 and second.json()["started"] is False

    task = events_api._tasks.get(case_id)
    release.set()
    if task is not None:
        await asyncio.wait_for(task, timeout=5)
    assert calls["n"] == 1
