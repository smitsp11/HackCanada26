"""Parts stage: the components implicated in the repair, named the way the
manual names them.

The single hard rule here is that a part number is a fact, not a guess. An
installation manual like the Carrier 59SC6A carries a "Parts Replacement
Information Guide" that lists parts by GROUP NAME - "Gas Control Group: Burner,
Flame sensor, Gas valve" - with no numbers at all, and tells the owner to phone
a dealer with the unit's rating-plate data. A model asked for part numbers
against a document like that will happily produce plausible ones, and a wrong
part number costs a homeowner a return shipment and a day without heat.

So numbers are handled adversarially:
  - the prompt forbids inventing one
  - every number that comes back is checked against the manual's own extracted
    text and dropped if it isn't there
  - `numbers_unavailable` is decided from the manual, not from the model

Purchase links are built here in Python for the same reason: a hallucinated URL
is indistinguishable from a real one until someone clicks it.
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import re
from typing import Any, Optional
from urllib.parse import quote_plus

from pypdf import PdfReader

from app.config import settings
from app.core import llm, manuals, pdf
from app.pipeline import verify as verify_pass
from app.schemas.contracts import ApplianceIdentity, Part, PartsList, RepairSummary

# Only the leading causes drive the parts list; the long tail of low-confidence
# causes would otherwise pad it with components nobody is going to replace.
TOP_CAUSES = 3
# Cap on manual pages sent to the model. Sending the whole 74-page manual costs
# ~96k prompt tokens; the cited pages plus the parts guide cost a tenth of that.
MAX_PAGES = 12

SEARCH_BASE = "https://www.repairclinic.com/Shop-For-Parts?query="

# Shapes a real appliance part number takes: 337683-401, KGAVT0701CVT.
PART_NUMBER_RE = re.compile(r"[0-9]{4,8}-[0-9]{2,5}|[A-Z]{2,}[0-9]{3,}[A-Z0-9]*")
PARTS_GUIDE_RE = re.compile(r"PARTS\s+(?:REPLACEMENT|LIST|CATALOG)", re.I)

PARTS_SCHEMA = {
    "type": "object",
    "properties": {
        "parts": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "The component name as the manual writes it.",
                    },
                    "part_number": {
                        "type": "string",
                        "description": (
                            "ONLY if the manual literally prints a number for this "
                            "component. Otherwise omit this field entirely."
                        ),
                    },
                    "manual_pages": {"type": "array", "items": {"type": "integer"}},
                    "note": {
                        "type": "string",
                        "description": "Why this part is implicated, or how the manual says to source it.",
                    },
                },
                "required": ["name", "manual_pages"],
                "additionalProperties": False,
            },
        },
        "parts_list_style": {
            "type": "string",
            "enum": ["group_names", "numbered", "none"],
            "description": "How the attached manual lists replacement parts.",
        },
    },
    "required": ["parts", "parts_list_style"],
    "additionalProperties": False,
}

SYSTEM = """You list the replacement parts implicated by a diagnosis, working
strictly from the manual pages you are given.

Rules you must follow:
- Name each component the way the manual names it.
- NEVER invent, infer, recall or reconstruct a part number. Supply part_number
  only when the attached pages literally print a number next to that component.
  Most service manuals list parts by group name with no numbers; in that case
  every part must come back with no part_number at all. That is the expected
  result, not a failure.
- A model number, a catalog number, a UPC or a kit number for a different
  accessory is not this part's number. Leave it out.
- Never output a URL, a price, a supplier, or a stock number.
- Cite the manual pages that mention each component, using the ORIGINAL manual
  page numbers listed below, not the position of the page in the attachment.
"""


# --------------------------------------------------------------------------
# Manual text helpers
# --------------------------------------------------------------------------


def _alnum(s: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", (s or "").upper())


def relevant_pages(
    summary: RepairSummary,
    page_count: int,
    *,
    extra: Optional[list[int]] = None,
    top_causes: int = TOP_CAUSES,
    limit: int = MAX_PAGES,
) -> list[int]:
    """Pages worth attaching: those the leading causes cited, plus `extra`.

    Shared with the instruct stage so both look at the same evidence the
    diagnosis was actually built on.
    """
    ordered = sorted(summary.causes, key=lambda c: c.confidence, reverse=True)
    pages: list[int] = []
    for cause in ordered[:top_causes]:
        for p in cause.manual_pages:
            if 1 <= p <= page_count and p not in pages:
                pages.append(p)
    for p in extra or []:
        if 1 <= p <= page_count and p not in pages:
            pages.append(p)
    return sorted(pages)[:limit]


def _parts_guide_pages(texts: list[str]) -> list[int]:
    return [i for i, t in enumerate(texts, 1) if PARTS_GUIDE_RE.search(t)]


def _numbers_unavailable(texts: list[str]) -> bool:
    """True when the manual's parts section is a group list rather than a catalog.

    Decided from the document, not from the model: find the parts section and
    count number-shaped tokens on it. The Carrier guide has none, so anything a
    model claims about it is noise.
    """
    guide = _parts_guide_pages(texts)
    if not guide:
        return True
    hits = sum(len(PART_NUMBER_RE.findall(texts[p - 1])) for p in guide)
    return hits < 2


def search_url(identity: ApplianceIdentity, name: str, part_number: Optional[str]) -> str:
    """Built here, never by the model. Number when we have one, else brand+model+name."""
    terms = [t for t in (identity.brand, identity.unit_number or identity.model_number) if t]
    terms.append(part_number or name)
    return SEARCH_BASE + quote_plus(" ".join(terms))


# --------------------------------------------------------------------------
# Verification, wired in here because parts is the first stage that consumes
# the diagnosis and therefore the first that should care whether it holds up.
# --------------------------------------------------------------------------


async def verify_summary(summary: RepairSummary, manual_pdf: Optional[bytes]) -> RepairSummary:
    """Mark each cause verified / not verified. Nothing is ever dropped.

    A cause is verified when its pages exist and no quote was refuted by the
    text of a page that plainly has text. UNVERIFIABLE quotes - the flowchart
    pages that are pure image - do not count against it. Removing unverified
    causes would hide the failure; flagging them lets the UI show it.
    """
    if not manual_pdf or not summary.causes:
        return summary
    texts = await manuals.page_texts(manual_pdf)
    report = await asyncio.to_thread(verify_pass.verify, summary, manual_pdf, texts)
    for cause, check in zip(summary.causes, report.causes):
        cause.verified = check.supported
    return summary


# --------------------------------------------------------------------------
# Stage
# --------------------------------------------------------------------------


def _user_prompt(identity: ApplianceIdentity, summary: RepairSummary, pages: list[int]) -> str:
    unit = identity.unit_number or identity.model_number or "unknown model"
    lines = [
        f"Appliance: {identity.brand or 'unknown brand'} {unit}"
        + (f" ({identity.appliance_type})" if identity.appliance_type else ""),
        "",
        f"Symptom: {summary.symptom_restated}",
        "",
        "Leading causes from the diagnosis:",
    ]
    ordered = sorted(summary.causes, key=lambda c: c.confidence, reverse=True)
    for i, cause in enumerate(ordered[:TOP_CAUSES], 1):
        lines.append(f"{i}. ({cause.confidence:.2f}) {cause.summary}")
        if cause.components:
            lines.append(f"   components named: {', '.join(cause.components)}")
        if cause.manual_pages:
            lines.append(f"   cited pages: {cause.manual_pages}")
    if pages:
        # The attachment is an excerpt, so its internal page numbering is wrong.
        lines += [
            "",
            "The attached PDF contains these manual pages, in this order: "
            + ", ".join(str(p) for p in pages)
            + ".",
            "Cite those original page numbers.",
        ]
    lines += [
        "",
        "List the parts a technician would need on hand to resolve the leading "
        "causes, most likely first. Include a part number only where the attached "
        "pages print one.",
    ]
    return "\n".join(lines)


async def run(
    manual_pdf: Optional[bytes],
    identity: ApplianceIdentity,
    summary: RepairSummary,
) -> tuple[PartsList, dict[str, Any]]:
    """Returns (parts_list, usage)."""
    if not manual_pdf:
        # No manual means no page can print a number, so there is nothing for a
        # model to read. Fall back to the components the diagnosis already named.
        return _from_components(identity, summary), {}

    texts = await manuals.page_texts(manual_pdf)
    page_count = len(texts)
    pages = relevant_pages(summary, page_count, extra=_parts_guide_pages(texts))
    excerpt = (await asyncio.to_thread(pdf.extract_pages, manual_pdf, pages)
               if pages else manual_pdf)

    parts_msg = [
        llm.pdf_part(excerpt, "manual-excerpt.pdf"),
        llm.text_part(_user_prompt(identity, summary, pages)),
    ]

    data, usage = await llm.llm.complete(
        parts_msg,
        model=settings.model_default,
        system=SYSTEM,
        schema=PARTS_SCHEMA,
        schema_name="parts_list",
        max_tokens=3000,
        has_pdf=True,
    )

    allowed = set(pages) if pages else set(range(1, page_count + 1))
    manual_alnum = _alnum(" ".join(texts))

    parts: list[Part] = []
    seen: set[str] = set()
    for raw in data.get("parts") or []:
        name = (raw.get("name") or "").strip()
        if not name or name.lower() in seen:
            continue
        seen.add(name.lower())

        number, note = _checked_number(raw.get("part_number"), manual_alnum, raw.get("note"))
        parts.append(
            Part(
                name=name,
                part_number=number,
                manual_pages=sorted({p for p in (raw.get("manual_pages") or []) if p in allowed}),
                search_url=search_url(identity, name, number),
                note=note,
            )
        )

    return (
        PartsList(
            parts=parts,
            numbers_unavailable=_numbers_unavailable(texts) or not any(p.part_number for p in parts),
        ),
        usage,
    )


def _checked_number(
    raw: Optional[str], manual_alnum: str, note: Optional[str]
) -> tuple[Optional[str], Optional[str]]:
    """Keep a number only if the manual's own text contains it.

    Compared on alphanumerics alone so a hyphen the model moved or dropped
    doesn't reject a real number. Short tokens are refused outright: a
    four-character string will match somewhere in 74 pages by accident.
    """
    number = (raw or "").strip()
    note = (note or "").strip() or None
    if not number:
        return None, note
    if len(_alnum(number)) >= 6 and _alnum(number) in manual_alnum:
        return number, note
    suppressed = f"Part number {number!r} was not printed in the manual and has been withheld."
    return None, f"{note} {suppressed}".strip() if note else suppressed


def _from_components(identity: ApplianceIdentity, summary: RepairSummary) -> PartsList:
    ordered = sorted(summary.causes, key=lambda c: c.confidence, reverse=True)
    parts: list[Part] = []
    seen: set[str] = set()
    for cause in ordered[:TOP_CAUSES]:
        for name in cause.components:
            if not name or name.lower() in seen:
                continue
            seen.add(name.lower())
            parts.append(
                Part(
                    name=name,
                    manual_pages=[],
                    search_url=search_url(identity, name, None),
                    note="No manual was available, so no part number can be confirmed.",
                )
            )
    return PartsList(parts=parts, numbers_unavailable=True)
