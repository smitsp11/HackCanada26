"""Check that cited manual pages actually support the claims made about them.

The failure this defends against is a confident, plausible diagnosis attached to
page numbers that were invented. A page number is trivially easy to fabricate
and impossible to eyeball, so it gets checked mechanically.

Three-way verdict per quote, because a binary one would lie:

  VERIFIED     the quote appears in the extractable text of a cited page
  UNVERIFIABLE the cited page holds almost no extractable text - it is a
               diagram or scanned table, so text search can neither confirm
               nor refute. Common and legitimate: on the Carrier 59SC6A the
               troubleshooting flowchart on p.72 is entirely an image.
  NOT_FOUND    the cited page has plenty of text and the quote is not in it.
               This is the one that matters.

UNVERIFIABLE is not a failure. NOT_FOUND is.
"""

from __future__ import annotations

import io
import re
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from enum import Enum
from typing import Optional

from pypdf import PdfReader

# Below this much extractable text, treat a page as a diagram rather than prose.
# Body pages in a service manual run 2000-4000 chars; a flowchart page with a
# caption runs a few hundred. The Carrier troubleshooting guide on p.72 yields
# 248, so a threshold of 200 misclassified it as verifiable text.
TEXT_PAGE_MIN_CHARS = 700
# Fuzzy threshold - models paraphrase whitespace, ligatures and line breaks.
MATCH_RATIO = 0.82


class Verdict(str, Enum):
    VERIFIED = "verified"
    UNVERIFIABLE = "unverifiable"
    NOT_FOUND = "not_found"


@dataclass
class QuoteCheck:
    quote: str
    pages: list[int]
    verdict: Verdict
    matched_page: Optional[int] = None
    ratio: float = 0.0


@dataclass
class CauseCheck:
    summary: str
    pages_in_range: bool
    out_of_range: list[int] = field(default_factory=list)
    quotes: list[QuoteCheck] = field(default_factory=list)

    @property
    def supported(self) -> bool:
        """Supported unless a quote was actively refuted or pages are bogus."""
        if not self.pages_in_range:
            return False
        return not any(q.verdict is Verdict.NOT_FOUND for q in self.quotes)


@dataclass
class VerificationReport:
    page_count: int
    causes: list[CauseCheck] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return all(c.supported for c in self.causes)

    def counts(self) -> dict[str, int]:
        out = {v.value: 0 for v in Verdict}
        for c in self.causes:
            for q in c.quotes:
                out[q.verdict.value] += 1
        return out

    def failures(self) -> list[str]:
        msgs = []
        for c in self.causes:
            if c.out_of_range:
                msgs.append(f"{c.summary[:60]!r}: pages out of range {c.out_of_range}")
            for q in c.quotes:
                if q.verdict is Verdict.NOT_FOUND:
                    msgs.append(
                        f"{c.summary[:60]!r}: quote not on pages {q.pages}: {q.quote[:80]!r}"
                    )
        return msgs


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "")).strip().lower()


def _split_ellipsis(quote: str) -> list[str]:
    """Break a quote on ellipses into the fragments it actually claims."""
    parts = [p.strip() for p in re.split(r"\.{3,}|…", quote or "")]
    return [p for p in parts if p] or [quote]


def _contains(haystack: str, needle: str) -> tuple[bool, float]:
    """Substring first, then a sliding fuzzy match for paraphrased whitespace."""
    if not needle:
        return False, 0.0
    if needle in haystack:
        return True, 1.0
    n = len(needle)
    if n < 20 or len(haystack) < n:
        return False, 0.0
    best = 0.0
    step = max(1, n // 4)
    for i in range(0, len(haystack) - n + 1, step):
        r = SequenceMatcher(None, needle, haystack[i : i + n]).ratio()
        if r > best:
            best = r
            if best >= MATCH_RATIO:
                return True, best
    return False, best


def verify(summary, pdf_bytes: bytes, page_texts: Optional[list[str]] = None) -> VerificationReport:
    """`summary` is a RepairSummary (or anything with .causes).

    Pass `page_texts` when you have them (they are stored at ingestion); the
    fallback extracts from `pdf_bytes`, which on a large manual is slow.
    """
    reader = None if page_texts is not None else PdfReader(io.BytesIO(pdf_bytes))
    total = len(page_texts) if page_texts is not None else len(reader.pages)
    cache: dict[int, str] = (
        {i: _norm(tx) for i, tx in enumerate(page_texts, start=1)} if page_texts is not None else {}
    )

    def text(page: int) -> str:
        if page not in cache:
            try:
                cache[page] = _norm(reader.pages[page - 1].extract_text() or "")
            except Exception:
                cache[page] = ""
        return cache[page]

    report = VerificationReport(page_count=total)

    for cause in getattr(summary, "causes", []):
        pages = list(cause.manual_pages or [])
        bad = [p for p in pages if not (1 <= p <= total)]
        check = CauseCheck(
            summary=cause.summary, pages_in_range=not bad, out_of_range=bad
        )
        valid = [p for p in pages if 1 <= p <= total]

        for quote in cause.evidence or []:
            # Models quote discontinuous passages joined by an ellipsis, e.g.
            # "Gas Control Group... Orifice". Treating that as one contiguous
            # string fails against a page where both fragments genuinely appear,
            # so score each fragment separately.
            fragments = [f for f in (_norm(f) for f in _split_ellipsis(quote)) if len(f) >= 6]
            hit_page, best = None, 0.0

            for p in valid:
                page_text = text(p)
                ratios = []
                for frag in fragments:
                    ok, ratio = _contains(page_text, frag)
                    ratios.append(ratio if ok else 0.0)
                if ratios and all(r > 0 for r in ratios):
                    hit_page, best = p, min(ratios)
                    break
                best = max(best, max(ratios) if ratios else 0.0)

            if hit_page:
                verdict = Verdict.VERIFIED
            elif not valid or any(len(text(p)) < TEXT_PAGE_MIN_CHARS for p in valid):
                # At least one cited page is a diagram, so the quote may well
                # have come from pixels that text extraction cannot see. That is
                # not evidence of fabrication.
                verdict = Verdict.UNVERIFIABLE
            else:
                verdict = Verdict.NOT_FOUND

            check.quotes.append(
                QuoteCheck(quote=quote, pages=valid, verdict=verdict,
                           matched_page=hit_page, ratio=round(best, 2))
            )

        report.causes.append(check)

    return report
