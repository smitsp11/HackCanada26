"""Side-by-side live test: the same case through two running backends.

    python -m app.eval.live_compare                       # 8000 (main) vs 8001 (retrieval)
    python -m app.eval.live_compare --symptom "..." --code 33

Drives the real HTTP API on both servers at the same time (create case ->
submit input -> run-async), then reads per-stage timings from the
server-side `pipeline_events` timestamps, so nothing here is client-measured
guesswork. Both backends share one database, which is what makes that work.
"""

from __future__ import annotations

import argparse
import asyncio
import time
from typing import Any

import httpx

from app.config import settings
from app.core import db
from app.pipeline import runner

TIMEOUT_S = 600


async def start_case(client: httpx.AsyncClient, base: str, symptom: str, code: str | None) -> str:
    h = {"Authorization": f"Bearer {settings.api_bearer_token}"}
    r = await client.post(f"{base}/api/cases", json={"appliance_type_hint": "furnace"}, headers=h)
    r.raise_for_status()
    case_id = r.json()["case_id"]
    r = await client.post(
        f"{base}/api/cases/{case_id}/input",
        json={"symptom": symptom, "error_code": code, "brand_hint": "Carrier", "model_hint": "59SC6A"},
        headers=h,
    )
    r.raise_for_status()
    r = await client.post(f"{base}/api/cases/{case_id}/run-async", headers=h)
    r.raise_for_status()
    return case_id


async def wait_and_time(case_id: str, t0: float) -> dict[str, Any]:
    while time.perf_counter() - t0 < TIMEOUT_S:
        if await runner.case_is_terminal(case_id):
            break
        await asyncio.sleep(1.0)
    wall = time.perf_counter() - t0
    rows = await db.fetch(
        "SELECT type, payload, ts FROM pipeline_events WHERE case_id=$1 ORDER BY seq", case_id
    )
    started: dict[str, Any] = {}
    stages: dict[str, float] = {}
    retrieval = None
    for r in rows:
        p = r["payload"] or {}
        if r["type"] == "stage_started":
            started[p.get("stage")] = r["ts"]
        elif r["type"] == "stage_completed" and p.get("stage") in started:
            stages[p["stage"]] = (r["ts"] - started[p["stage"]]).total_seconds()
        elif r["type"] == "retrieval_completed":
            retrieval = p
    first, last = (rows[0]["ts"], rows[-1]["ts"]) if rows else (None, None)
    usage = await db.fetchval(
        "SELECT usage FROM stage_runs WHERE case_id=$1 AND stage='diagnose'", case_id
    ) or {}
    status = await db.fetchval("SELECT status FROM cases WHERE case_id=$1", case_id)
    return {
        "case_id": case_id,
        "status": status,
        "wall_s": round(wall, 1),
        "pipeline_s": round((last - first).total_seconds(), 1) if rows else None,
        "stages_s": {k: round(v, 1) for k, v in stages.items()},
        "diagnose_prompt_tokens": usage.get("prompt_tokens"),
        "retrieved_pages": (retrieval or {}).get("pages"),
        "retrieval_ms": ((retrieval or {}).get("timings_ms") or {}).get("total"),
    }


async def one(client: httpx.AsyncClient, base: str, symptom: str, code: str | None) -> dict[str, Any]:
    t0 = time.perf_counter()
    case_id = await start_case(client, base, symptom, code)
    return {"server": base} | await wait_and_time(case_id, t0)


async def main() -> int:
    ap = argparse.ArgumentParser(prog="app.eval.live_compare")
    ap.add_argument("--baseline", default="http://localhost:8000")
    ap.add_argument("--retrieval", default="http://localhost:8001")
    ap.add_argument("--symptom", default=(
        "Furnace fires up, runs a few minutes, then the burners shut off. The display shows 33."))
    ap.add_argument("--code", default="33")
    args = ap.parse_args()

    await db.init_pool()
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            results = await asyncio.gather(
                one(client, args.baseline, args.symptom, args.code),
                one(client, args.retrieval, args.symptom, args.code),
            )
    finally:
        await db.close_pool()

    for label, r in zip(("MAIN (full manual)", "RETRIEVAL"), results):
        print(f"\n{label}  {r['server']}  case={r['case_id']}  status={r['status']}")
        print(f"  end-to-end wall     {r['wall_s']:>6}s")
        print(f"  stages              {r['stages_s']}")
        print(f"  diagnose prompt tok {r['diagnose_prompt_tokens']}")
        if r["retrieved_pages"]:
            print(f"  retrieved pages     {r['retrieved_pages']}  ({r['retrieval_ms']} ms)")
    b, x = results
    if b["stages_s"].get("diagnose") and x["stages_s"].get("diagnose"):
        d0, d1 = b["stages_s"]["diagnose"], x["stages_s"]["diagnose"]
        print(f"\ndiagnose stage: {d0}s -> {d1}s  ({(d1 - d0) / d0:+.0%})")
    print(f"end-to-end:     {b['wall_s']}s -> {x['wall_s']}s  ({(x['wall_s'] - b['wall_s']) / b['wall_s']:+.0%})")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
