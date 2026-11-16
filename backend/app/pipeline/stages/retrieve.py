"""Retrieve stage: symptom -> the handful of manual pages diagnose should read.

Deliberately has no LLM call on the hot path. Search itself is milliseconds;
model calls are where latency lives, and the win this stage exists for is
shrinking the diagnose call from the whole manual (~96k prompt tokens) to a
few pages. Spending a query-rewrite call to get there would give some of it
back.

Order of evidence:
  1. Exact status-code lookup. A displayed code is the highest-precision
     signal there is; it gets the pages the index says explain that code,
     no similarity involved.
  2. Hybrid search (full-text + vector, fused with RRF in SQL), always
     filtered to this appliance's manual_id.

Returns page numbers, not text: diagnose still reads the rendered pages, so
flowcharts and tables reach the model as pixels.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from typing import Any, Optional

from app.config import settings
from app.core import db, embeddings
from app.schemas.contracts import ApplianceIdentity

# Code pages are exact but a code can be mentioned on many pages; cap them so
# they cannot crowd out the symptom matches entirely.
MAX_CODE_PAGES = 4

# Two-digit major code, optional .minor, introduced by display/status wording.
# Flash counts ("flashing 3 times") are deliberately not codes.
_CODE_IN_TEXT = re.compile(
    r"\b(?:code|status|fault|error|display(?:s|ed)?|shows|reads|says)\D{0,12}?(\d{2}(?:\.\d)?)(?!\d)",
    re.IGNORECASE,
)


@dataclass
class RetrievalResult:
    pages: list[int]                      # ranked, best first
    query: str
    code: Optional[str] = None
    code_pages: list[int] = field(default_factory=list)
    hits: list[dict[str, Any]] = field(default_factory=list)
    timings_ms: dict[str, float] = field(default_factory=dict)
    usage: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {
            "pages": self.pages,
            "query": self.query,
            "code": self.code,
            "code_pages": self.code_pages,
            "hits": self.hits,
            "timings_ms": self.timings_ms,
        }


def extract_code(symptom: str, error_code: Optional[str]) -> Optional[str]:
    """The displayed code, from the explicit field or the symptom text."""
    for source in (error_code, symptom):
        if not source:
            continue
        if source is error_code:
            digits = re.sub(r"[^0-9.]", "", source).strip(".")
            if digits:
                return digits
        m = _CODE_IN_TEXT.search(source)
        if m:
            return m.group(1)
    return None


def build_query(identity: ApplianceIdentity, symptom: str, code: Optional[str]) -> str:
    parts = [symptom.strip()]
    if code:
        parts.append(f"status code {code}")
    if identity.appliance_type:
        parts.append(identity.appliance_type)
    return ". ".join(p for p in parts if p)


async def run(
    manual_id: str,
    identity: ApplianceIdentity,
    symptom: str,
    *,
    error_code: Optional[str] = None,
    top_k: Optional[int] = None,
) -> RetrievalResult:
    top_k = top_k or settings.retrieval_top_k
    code = extract_code(symptom, error_code)
    result = RetrievalResult(pages=[], query="", code=code)

    t = time.perf_counter()
    if code:
        major = code.split(".")[0]
        rows = await db.fetch(
            """SELECT page FROM manual_pages
                WHERE manual_id=$1
                  AND EXISTS (SELECT 1 FROM unnest(status_codes) c
                               WHERE c = $2 OR split_part(c, '.', 1) = $3)
                ORDER BY image_heavy DESC, page""",
            manual_id, code, major,
        )
        result.code_pages = [r["page"] for r in rows][:MAX_CODE_PAGES]
    result.timings_ms["code_lookup"] = round((time.perf_counter() - t) * 1000, 1)

    # A "code" the manual never explains (a thermostat reading, a flash count)
    # must not steer the text query.
    query = build_query(identity, symptom, code if result.code_pages else None)
    result.query = query

    t = time.perf_counter()
    vecs, usage = await embeddings.embed([query])
    result.usage = usage
    result.timings_ms["embed"] = round((time.perf_counter() - t) * 1000, 1)

    t = time.perf_counter()
    rows = await db.fetch(
        "SELECT page, score, fts_rank, vec_rank FROM match_manual_pages($1, $2, $3::vector, $4)",
        manual_id, query, embeddings.to_pgvector(vecs[0]), top_k,
    )
    result.timings_ms["hybrid_search"] = round((time.perf_counter() - t) * 1000, 1)
    result.hits = [
        {"page": r["page"], "score": round(r["score"], 5),
         "fts_rank": r["fts_rank"], "vec_rank": r["vec_rank"]}
        for r in rows
    ]

    ranked: list[int] = []
    for p in result.code_pages + [h["page"] for h in result.hits]:
        if p not in ranked:
            ranked.append(p)
    result.pages = ranked[:top_k]
    result.timings_ms["total"] = round(sum(result.timings_ms.values()), 1)
    return result
