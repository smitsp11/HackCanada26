"""Diagnose-stage configuration experiment: latency against accuracy.

    python -m app.eval.configs                          # every config, every case
    python -m app.eval.configs --configs full_url,full_url_low --concurrency 3
    python -m app.eval.configs --summarize eval/results/configs-<ts>.json

Mirrors the retrieval branch's benchmark (app/eval/bench.py there) so results
compare directly: same 16 cases (eval/cases.json, copied byte-identical), same
fixed identity, no photos, error code passed, one retry on failure, and the
same `cite_hit` / `top_cite_hit` definitions against the expected pages.

Those labels are marked DRAFT upstream, so three checks that don't depend on
them are added:
  code_hit   for cases showing a status code, the diagnosis names that code
  verified   every quoted phrase is on a page it cites, per app.pipeline.verify
  finish     "length" means the output hit max_tokens - a truncated response

Configs are interleaved - (case, config) pairs shuffled with a fixed seed across
one worker pool - so provider speed drifting over the run lands on every config
equally instead of on whichever ran last.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import random
import statistics
import time
from pathlib import Path
from typing import Any

from app.config import BASE_DIR
from app.core import db, manuals, pdf, storage
from app.pipeline import verify
from app.pipeline.stages import diagnose
from app.schemas.contracts import ApplianceIdentity, IdentityLevel

EVAL_DIR = BASE_DIR / "eval"
PRO, FLASH = "google/gemini-2.5-pro", "google/gemini-2.5-flash"
MANUAL_ID = "carrier-59sc6a"
# Status-code table (54), sequence of operation (68-69), troubleshooting guide
# (70-72): taken from the retrieval branch's page index. Sent with every excerpt.
ANCHORS = [54, 68, 69, 70, 71, 72]

CONFIGS: dict[str, dict[str, Any]] = {
    "full_b64":        {"mode": "full", "via": "b64", "model": PRO, "effort": None},
    "full_url":        {"mode": "full", "via": "url", "model": PRO, "effort": None},
    "full_url_low":    {"mode": "full", "via": "url", "model": PRO, "effort": "low"},
    "excerpt_pro":     {"mode": "excerpt", "model": PRO, "effort": None},
    "excerpt_pro_low": {"mode": "excerpt", "model": PRO, "effort": "low"},
    "excerpt_flash":   {"mode": "excerpt", "model": FLASH, "effort": None},
}


def identity() -> ApplianceIdentity:
    return ApplianceIdentity(
        brand="Carrier", model_number="59SC6A", appliance_type="gas furnace",
        confidence=1.0, identity_level=IdentityLevel.EXACT, manual_id=MANUAL_ID,
        catalog_matched=True,
    )


def _major(code: str) -> str:
    return str(code).strip().split(".")[0]


def _code_hit(expected: str | None, summary) -> float | None:
    if not expected:
        return None
    want = _major(expected)
    for c in summary.causes:
        if any(_major(x) == want for x in (c.error_codes or [])):
            return 1.0
    return 0.0


async def run_one(case: dict, name: str, cfg: dict, ctx: dict) -> dict[str, Any]:
    ident = identity()
    expected = set(case["expected_pages"])
    kwargs: dict[str, Any] = {
        "error_code": case.get("error_code"),
        "model": cfg["model"],
        "reasoning": {"effort": cfg["effort"]} if cfg["effort"] else None,
    }
    if cfg["mode"] == "full":
        data = ctx["manual"]
        if cfg["via"] == "url":
            kwargs["manual_url"] = ctx["url"]
    else:
        pages = sorted(set(ctx["retrieved"][case["id"]]) | set(ANCHORS))
        data = ctx["excerpts"][case["id"]]
        kwargs["page_numbers"] = pages

    row: dict[str, Any] = {"id": case["id"], "config": name, "attempts": 0}
    t0 = time.perf_counter()
    for attempt in range(2):
        row["attempts"] = attempt + 1
        try:
            summary, usage = await diagnose.run(data, ident, case["symptom"], **kwargs)
            break
        except Exception as e:  # noqa: BLE001
            row.setdefault("errors", []).append(str(e)[:240])
            if attempt == 1:
                row.update(failed=True, latency_s=round(time.perf_counter() - t0, 2))
                print(f"  FAIL {name:16} {case['id']:26} {str(e)[:90]}")
                return row
    latency = time.perf_counter() - t0

    cited = {p for c in summary.causes for p in c.manual_pages}
    top = set(summary.causes[0].manual_pages) if summary.causes else set()
    report = verify.verify(summary, ctx["manual"], ctx["texts"])
    row.update(
        failed=False,
        latency_s=round(latency, 2),
        call_s=usage.get("latency_s"),
        prompt_tokens=usage.get("prompt_tokens"),
        completion_tokens=usage.get("completion_tokens"),
        reasoning_tokens=usage.get("reasoning_tokens"),
        finish=usage.get("finish_reason"),
        request_mb=usage.get("request_mb"),
        cost=usage.get("cost"),
        cited=sorted(cited),
        expected=sorted(expected),
        cite_hit=float(bool(cited & expected)),
        top_cite_hit=float(bool(top & expected)),
        code_hit=_code_hit(case.get("error_code"), summary),
        verified=float(report.ok),
        abstained=float(summary.abstained),
        causes=[{"summary": c.summary, "confidence": c.confidence, "pages": c.manual_pages,
                 "codes": c.error_codes} for c in summary.causes[:3]],
    )
    print(f"  ok   {name:16} {case['id']:26} {latency:6.1f}s  reason={row['reasoning_tokens']}  "
          f"cite={row['cite_hit']:.0f} top={row['top_cite_hit']:.0f} code={row['code_hit']}")
    return row


def _pct(xs: list[float], q: float) -> float | None:
    xs = sorted(x for x in xs if x is not None)
    if not xs:
        return None
    k = max(0, min(len(xs) - 1, round(q * (len(xs) - 1))))
    return round(xs[k], 1)


def summarize(rows: list[dict[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for name in dict.fromkeys(r["config"] for r in rows):
        rs = [r for r in rows if r["config"] == name]
        ok = [r for r in rs if not r.get("failed")]

        def mean(key: str) -> float | None:
            vals = [r[key] for r in ok if r.get(key) is not None]
            return round(statistics.mean(vals), 3) if vals else None

        lat = [r["latency_s"] for r in ok]
        out[name] = {
            "n": len(rs), "failed": len(rs) - len(ok),
            "retried": sum(1 for r in rs if r["attempts"] > 1),
            "truncated": sum(1 for r in ok if r.get("finish") == "length"),
            "latency_p50": _pct(lat, 0.5), "latency_p90": _pct(lat, 0.9),
            "latency_mean": round(statistics.mean(lat), 1) if lat else None,
            "reasoning_mean": mean("reasoning_tokens"),
            "completion_mean": mean("completion_tokens"),
            "prompt_mean": mean("prompt_tokens"),
            "cost_mean": mean("cost"),
            "cite_hit": mean("cite_hit"), "top_cite_hit": mean("top_cite_hit"),
            "code_hit": mean("code_hit"), "verified": mean("verified"),
        }
    return out


def print_table(summary: dict[str, Any]) -> None:
    cols = ["n", "failed", "latency_p50", "latency_p90", "reasoning_mean", "cost_mean",
            "cite_hit", "top_cite_hit", "code_hit", "verified", "truncated"]
    print("\n" + "config".ljust(17) + "".join(c.replace("_mean", "").replace("latency_", "")
                                              .rjust(11) for c in cols))
    for name, s in summary.items():
        print(name.ljust(17) + "".join(str(s.get(c)).rjust(11) for c in cols))


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--configs", default=",".join(CONFIGS))
    ap.add_argument("--cases", default="")
    ap.add_argument("--concurrency", type=int, default=3)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--summarize", default="")
    args = ap.parse_args()

    if args.summarize:
        rows = json.loads(Path(args.summarize).read_text())["rows"]
        print_table(summarize(rows))
        return 0

    names = [c for c in args.configs.split(",") if c]
    cases = json.loads((EVAL_DIR / "cases.json").read_text())["cases"]
    if args.cases:
        want = set(args.cases.split(","))
        cases = [c for c in cases if c["id"] in want]

    await db.init_pool()
    try:
        path = await db.fetchval("SELECT pdf_path FROM manuals WHERE manual_id=$1", MANUAL_ID)
        manual = await manuals.pdf_bytes(MANUAL_ID, path)
        retrieved = json.loads((EVAL_DIR / "retrieved_pages.json").read_text())["retrieved"]
        ctx = {
            "manual": manual,
            "texts": await manuals.page_texts(manual),
            "url": await storage.create_signed_download_url(path, ttl=4 * 3600),
            "retrieved": retrieved,
            "excerpts": {
                c["id"]: pdf.extract_pages(manual, sorted(set(retrieved[c["id"]]) | set(ANCHORS)))
                for c in cases
            },
        }
        sizes = [len(b) / 1e6 for b in ctx["excerpts"].values()]
        print(f"{len(cases)} cases x {len(names)} configs; excerpts {min(sizes):.1f}-{max(sizes):.1f} MB, "
              f"{min(len(set(retrieved[c['id']]) | set(ANCHORS)) for c in cases)}-"
              f"{max(len(set(retrieved[c['id']]) | set(ANCHORS)) for c in cases)} pages")

        jobs = [(c, n) for c in cases for n in names]
        random.Random(args.seed).shuffle(jobs)
        sem = asyncio.Semaphore(args.concurrency)

        async def go(c, n):
            async with sem:
                return await run_one(c, n, CONFIGS[n], ctx)

        started = time.strftime("%Y%m%d-%H%M%S")
        rows = await asyncio.gather(*(go(c, n) for c, n in jobs))
    finally:
        await db.close_pool()

    summary = summarize(rows)
    out = EVAL_DIR / "results" / f"configs-{started}.json"
    out.write_text(json.dumps({"configs": {n: CONFIGS[n] for n in names}, "anchors": ANCHORS,
                               "concurrency": args.concurrency, "summary": summary,
                               "rows": rows}, indent=1))
    print_table(summary)
    print(f"\nwrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
