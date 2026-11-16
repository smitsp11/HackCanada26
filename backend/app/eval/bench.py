"""Retrieval vs full-manual benchmark.

    # retrieval quality only (fast, no generation)
    python -m app.eval.bench retrieval

    # diagnose end to end, current design (whole manual) vs retrieval
    python -m app.eval.bench diagnose --path full
    python -m app.eval.bench diagnose --path retrieval

Cases live in eval/cases.json: a symptom (optionally a displayed code) and the
manual pages a technician would need to answer it. Results are written to
eval/results/<mode>-<path>-<timestamp>.json.

Metrics
  hit@k        at least one expected page is in the top k retrieved
  recall@k     fraction of expected pages in the top k
  MRR          1 / rank of the first expected page
  cite_hit     diagnose cited at least one expected page (any cause)
  top_cite_hit the top-ranked cause cited an expected page
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import statistics
import time
from pathlib import Path
from typing import Any

from app.config import BASE_DIR
from app.core import db, pdf
from app.pipeline.stages import diagnose, retrieve
from app.schemas.contracts import ApplianceIdentity, IdentityLevel

EVAL_DIR = BASE_DIR / "eval"
MANUAL = BASE_DIR / "manuals" / "opera-manual.pdf"
KS = (3, 5, 8)


def load_cases() -> list[dict[str, Any]]:
    return json.loads((EVAL_DIR / "cases.json").read_text())["cases"]


async def resolve_manual() -> tuple[str, bytes]:
    data = MANUAL.read_bytes()
    row = await db.fetchrow(
        "SELECT manual_id FROM manuals WHERE pdf_sha256=$1", hashlib.sha256(data).hexdigest()
    )
    if not row:
        raise SystemExit("manual not ingested - run `python -m app.ingestion.cli add` first")
    return row["manual_id"], data


def identity(manual_id: str) -> ApplianceIdentity:
    return ApplianceIdentity(
        brand="Carrier", model_number="59SC6A", appliance_type="gas furnace",
        confidence=1.0, identity_level=IdentityLevel.EXACT,
        manual_id=manual_id, catalog_matched=True,
    )


def rank_metrics(ranked: list[int], expected: set[int]) -> dict[str, float]:
    out: dict[str, float] = {}
    for k in KS:
        top = set(ranked[:k])
        out[f"hit@{k}"] = float(bool(top & expected))
        out[f"recall@{k}"] = len(top & expected) / len(expected)
    first = next((i for i, p in enumerate(ranked, 1) if p in expected), None)
    out["mrr"] = 1 / first if first else 0.0
    return out


def mean(rows: list[dict[str, Any]], key: str) -> float:
    vals = [r[key] for r in rows if r.get(key) is not None]
    return round(statistics.mean(vals), 3) if vals else 0.0


def pctl(vals: list[float], q: float) -> float:
    if not vals:
        return 0.0
    vals = sorted(vals)
    return round(vals[min(len(vals) - 1, int(q * len(vals)))], 2)


async def bench_retrieval(manual_id: str, cases: list[dict[str, Any]]) -> dict[str, Any]:
    ident = identity(manual_id)
    rows = []
    for c in cases:
        r = await retrieve.run(manual_id, ident, c["symptom"], error_code=c.get("error_code"),
                               top_k=max(KS))
        expected = set(c["expected_pages"])
        m = rank_metrics(r.pages, expected)
        rows.append({"id": c["id"], "retrieved": r.pages, "expected": sorted(expected),
                     "code_pages": r.code_pages, "ms": r.timings_ms["total"], **m})
        print(f"  {c['id']:<22} hit@5={m['hit@5']:.0f} mrr={m['mrr']:.2f} "
              f"got={r.pages} want={sorted(expected)}")
    summary = {k: mean(rows, k) for k in rows[0] if k.startswith(("hit@", "recall@", "mrr"))}
    summary["retrieval_ms_p50"] = pctl([r["ms"] for r in rows], 0.5)
    return {"summary": summary, "cases": rows}


async def bench_diagnose(manual_id: str, data: bytes, cases: list[dict[str, Any]],
                         path: str, concurrency: int) -> dict[str, Any]:
    ident = identity(manual_id)
    sem = asyncio.Semaphore(concurrency)

    async def one(c: dict[str, Any]) -> dict[str, Any]:
        async with sem:
            expected = set(c["expected_pages"])
            t0 = time.perf_counter()
            pages, retrieval_ms = None, 0.0
            if path == "retrieval":
                r = await retrieve.run(manual_id, ident, c["symptom"], error_code=c.get("error_code"))
                pages, retrieval_ms = r.pages, r.timings_ms["total"]
            t1 = time.perf_counter()
            # One retry on a malformed/empty model response, as the runner's
            # with_retry would; latency includes the retry, as a user would feel it.
            for attempt in range(2):
                try:
                    page_numbers = sorted(pages) if pages else None
                    doc = pdf.extract_pages(data, page_numbers) if page_numbers else data
                    summary, usage = await diagnose.run(doc, ident, c["symptom"],
                                                        error_code=c.get("error_code"),
                                                        page_numbers=page_numbers)
                    break
                except Exception as e:  # noqa: BLE001
                    print(f"  {c['id']}: attempt {attempt + 1} failed: {str(e)[:100]}")
                    if attempt == 1:
                        return {"id": c["id"], "failed": True, "error": str(e)[:300]}
            t2 = time.perf_counter()
        cited = {p for cause in summary.causes for p in cause.manual_pages}
        top = set(summary.causes[0].manual_pages) if summary.causes else set()
        row = {
            "id": c["id"],
            "pages_sent": len(pages) if pages else None,
            "retrieved": pages,
            "latency_s": round(t2 - t0, 2),
            "diagnose_s": round(t2 - t1, 2),
            "retrieval_ms": retrieval_ms,
            "prompt_tokens": usage.get("prompt_tokens"),
            "completion_tokens": usage.get("completion_tokens"),
            "cost": usage.get("cost"),
            "cited": sorted(cited),
            "expected": sorted(expected),
            "cite_hit": float(bool(cited & expected)),
            "top_cite_hit": float(bool(top & expected)),
            "abstained": float(summary.abstained),
            "top_cause": summary.causes[0].summary if summary.causes else None,
        }
        print(f"  {c['id']:<22} {row['latency_s']:>6.1f}s  {row['prompt_tokens'] or 0:>7} tok  "
              f"cite_hit={row['cite_hit']:.0f}  cited={row['cited']}")
        return row

    results = await asyncio.gather(*(one(c) for c in cases))
    failed = [r for r in results if r.get("failed")]
    rows = [r for r in results if not r.get("failed")]
    lat = [r["latency_s"] for r in rows]
    summary = {
        "n": len(rows),
        "latency_s_p50": pctl(lat, 0.5),
        "latency_s_p90": pctl(lat, 0.9),
        "latency_s_mean": round(statistics.mean(lat), 2),
        "prompt_tokens_mean": mean(rows, "prompt_tokens"),
        "completion_tokens_mean": mean(rows, "completion_tokens"),
        "cost_mean": mean(rows, "cost"),
        "cost_total": round(sum(r["cost"] or 0 for r in rows), 4),
        "cite_hit": mean(rows, "cite_hit"),
        "top_cite_hit": mean(rows, "top_cite_hit"),
        "abstain_rate": mean(rows, "abstained"),
        "concurrency": concurrency,
        "failed": len(failed),
    }
    return {"summary": summary, "cases": rows, "failed": failed}


async def main() -> int:
    ap = argparse.ArgumentParser(prog="app.eval.bench")
    ap.add_argument("mode", choices=["retrieval", "diagnose"])
    ap.add_argument("--path", choices=["full", "retrieval"], default="full")
    ap.add_argument("--concurrency", type=int, default=3)
    ap.add_argument("--only", nargs="*", help="case ids to run")
    args = ap.parse_args()

    cases = load_cases()
    if args.only:
        cases = [c for c in cases if c["id"] in set(args.only)]

    await db.init_pool()
    try:
        manual_id, data = await resolve_manual()
        if args.mode == "retrieval":
            result = await bench_retrieval(manual_id, cases)
            tag = "retrieval"
        else:
            result = await bench_diagnose(manual_id, data, cases, args.path, args.concurrency)
            tag = f"diagnose-{args.path}"
    finally:
        await db.close_pool()

    out_dir = EVAL_DIR / "results"
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{tag}-{time.strftime('%Y%m%d-%H%M%S')}.json"
    out.write_text(json.dumps(result, indent=2, default=str))
    print(json.dumps(result["summary"], indent=2))
    print(f"wrote {out.relative_to(BASE_DIR)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
