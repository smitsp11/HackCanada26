"""Instruct stage: what the user should actually do next.

Which of two documents this produces is decided before the model is called, by
the deterministic gate in `app.pipeline.safety`. For a gas furnace the verdict
is TECHNICIAN, and then step-by-step repair instructions are not something to
soften or hedge - they are simply not generated. The prompt for that branch
cannot produce them because the schema has nowhere to put them.

But "call a professional" on its own is a useless answer, and worse, it is the
answer a user works around. So a technician result still carries:
  - a brief the user can hand to whoever shows up: likely cause, the values to
    measure, the pages to read
  - the checks the manual itself says an untrained person may perform, which on
    this manual are filter, thermostat, breaker, gas cock, condensate, and
    reading the status code off the board

Those check texts come from `safety.HOMEOWNER_SAFE`, not from the model. The
model is only allowed to say which manual pages back each one up.
"""

from __future__ import annotations

import re

from typing import Any, Optional

from app.config import settings
from app.core import llm, pdf
from app.pipeline.safety import HOMEOWNER_SAFE
from app.pipeline.stages.parts import relevant_pages
from app.schemas.contracts import (
    ApplianceIdentity,
    RepairInstructions,
    RepairSummary,
    SafetyAssessment,
    Step,
    Verdict,
)

# Nothing gets opened before the power is off. This is step 1 of every DIY
# procedure regardless of what the model returns.
POWER_FIRST = "Disconnect electrical power to the appliance at the service switch and at the breaker, and confirm it is off before removing any panel."
_POWER_WORDS = ("disconnect", "turn off", "shut off", "cut power", "power off")

_STEP_ITEM = {
    "type": "object",
    "properties": {
        "instruction": {"type": "string"},
        "caution": {"type": "string"},
        "tools": {"type": "array", "items": {"type": "string"}},
        "manual_pages": {"type": "array", "items": {"type": "integer"}},
        "figure_ref": {
            "type": "string",
            "description": "A figure label printed in the manual, e.g. 'Fig. 68'. Omit if none applies.",
        },
    },
    "required": ["instruction", "manual_pages"],
    "additionalProperties": False,
}

DIY_SCHEMA = {
    "type": "object",
    "properties": {
        "steps": {"type": "array", "items": _STEP_ITEM},
        "safety_notes": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["steps", "safety_notes"],
    "additionalProperties": False,
}

TECH_SCHEMA = {
    "type": "object",
    "properties": {
        "technician_brief": {
            "type": "string",
            "description": (
                "A handover note for the service technician: the likely cause, the "
                "specification values to measure and where the manual states them, "
                "and the manual pages worth reading. Plain prose, a few short "
                "paragraphs."
            ),
        },
        "safety_notes": {"type": "array", "items": {"type": "string"}},
        "homeowner_checks": {
            "type": "array",
            "description": "Citations for the numbered homeowner-safe checks listed in the prompt.",
            "items": {
                "type": "object",
                "properties": {
                    "check_index": {"type": "integer"},
                    "manual_pages": {"type": "array", "items": {"type": "integer"}},
                    "caution": {"type": "string"},
                },
                "required": ["check_index", "manual_pages"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["technician_brief", "safety_notes", "homeowner_checks"],
    "additionalProperties": False,
}

DIY_SYSTEM = """You write repair instructions for a homeowner, working strictly
from the manual pages you are given.

Rules you must follow:
- Order the steps as they must be performed.
- Cite the manual pages that support each step. If the manual does not cover a
  step, leave its pages empty rather than citing a page that does not say it.
- Reference a figure only by a label the manual actually prints.
- Never invent a specification value, a torque, a voltage or a part number.
- Say what tools the step needs, and what could go wrong if it is done wrong.
"""

TECH_SYSTEM = """You are preparing a service call, not a repair procedure.

This appliance has been ruled off-limits to the homeowner by a safety rule, so
you must NOT write repair steps, disassembly instructions or component
replacement procedures. Write only the handover brief for the qualified
technician and the citations requested.

Rules you must follow:
- The brief states the likely cause, the measurements to take with the values
  the manual specifies, and the manual pages that matter.
- Quote specification values only where the manual prints them.
- Never invent a value, a page number or a part number.
"""


def _appliance_line(identity: ApplianceIdentity) -> str:
    unit = identity.unit_number or identity.model_number or "unknown model"
    suffix = f" ({identity.appliance_type})" if identity.appliance_type else ""
    return f"Appliance: {identity.brand or 'unknown brand'} {unit}{suffix}"


def _context(identity: ApplianceIdentity, summary: RepairSummary, pages: list[int]) -> list[str]:
    lines = [_appliance_line(identity), "", f"Symptom: {summary.symptom_restated}", ""]
    ordered = sorted(summary.causes, key=lambda c: c.confidence, reverse=True)
    lines.append("Diagnosis, most likely first:")
    for i, cause in enumerate(ordered[:3], 1):
        lines.append(f"{i}. ({cause.confidence:.2f}) {cause.summary}")
        if cause.detail:
            lines.append(f"   {cause.detail}")
        if cause.manual_pages:
            lines.append(f"   cited pages: {cause.manual_pages}")
    if pages:
        # The attachment is an excerpt; its internal numbering is not the manual's.
        lines += [
            "",
            "The attached PDF contains these manual pages, in this order: "
            + ", ".join(str(p) for p in pages)
            + ". Cite those original page numbers.",
        ]
    return lines


def _clamp(raw: Any, allowed: set[int]) -> list[int]:
    return sorted({p for p in (raw or []) if isinstance(p, int) and p in allowed})


def _mentions_power_cut(instruction: str) -> bool:
    low = (instruction or "").lower()
    return "power" in low and any(w in low for w in _POWER_WORDS)


async def run(
    manual_pdf: Optional[bytes],
    identity: ApplianceIdentity,
    summary: RepairSummary,
    safety: SafetyAssessment,
) -> tuple[RepairInstructions, dict[str, Any]]:
    """Returns (instructions, usage). The safety verdict picks the branch."""
    page_count = pdf.page_count(manual_pdf) if manual_pdf else 0
    # Wider than the parts stage on purpose: a procedure needs the maintenance
    # and specification pages behind the lesser causes too, not just the top few.
    pages = relevant_pages(
        summary, page_count, extra=safety.manual_pages, top_causes=5
    ) if page_count else []
    excerpt = pdf.extract_pages(manual_pdf, pages) if (manual_pdf and pages) else manual_pdf
    allowed = set(pages) if pages else set(range(1, page_count + 1))

    technician = safety.verdict is Verdict.TECHNICIAN
    lines = _context(identity, summary, pages)

    if technician:
        lines += [
            "",
            "The safety gate routed this repair to a qualified technician because:",
            *(f"- {r}" for r in safety.reasons),
            "",
            "These are the only checks the homeowner may perform. Do not rewrite "
            "them; for each one, give the manual pages that support it and, only "
            "if there is a real hazard, a caution. A caution is a short safety "
            "warning addressed to the homeowner, e.g. 'Do not relight the furnace "
            "if you smell gas.' If there is no hazard, leave caution empty. Never "
            "use it to comment on what the manual does or does not cover:",
            *(f"{i}. {c}" for i, c in enumerate(HOMEOWNER_SAFE, 1)),
            "",
            "Write the technician brief.",
        ]
    else:
        lines += [
            "",
            "Write the repair procedure for the homeowner, in order. Step 1 is "
            "always disconnecting electrical power.",
        ]

    msg: list[dict[str, Any]] = []
    if excerpt:
        msg.append(llm.pdf_part(excerpt, "manual-excerpt.pdf"))
    msg.append(llm.text_part("\n".join(lines)))

    data, usage = await llm.llm.complete(
        msg,
        model=settings.model_default,
        system=TECH_SYSTEM if technician else DIY_SYSTEM,
        schema=TECH_SCHEMA if technician else DIY_SCHEMA,
        schema_name="technician_brief" if technician else "repair_instructions",
        max_tokens=4000,
        has_pdf=bool(excerpt),
    )

    build = _technician_result if technician else _diy_result
    return build(data, safety, summary, allowed), usage


_META_CAUTION = re.compile(
    r"\b(?:the|this) (?:manual|document|guide)\b.{0,60}?\b(?:does not|doesn't|do not|"
    r"does not provide|not (?:specify|provide|mention|include|describe|cover)|no specific)\b",
    re.IGNORECASE,
)


def _clean_caution(text: Optional[str]) -> Optional[str]:
    """Drop cautions that are commentary about the manual rather than warnings.

    The client renders this field as "Caution: ...", so "The manual does not
    specify how to replace the filter" reads to a homeowner as a hazard notice.
    The prompt forbids it; this catches it when the prompt is ignored anyway.
    """
    text = (text or "").strip()
    if not text or _META_CAUTION.search(text):
        return None
    return text


def _technician_result(
    data: dict[str, Any],
    safety: SafetyAssessment,
    summary: RepairSummary,
    allowed: set[int],
) -> RepairInstructions:
    cites = {
        int(c.get("check_index") or 0): c
        for c in (data.get("homeowner_checks") or [])
        if isinstance(c, dict)
    }

    steps = []
    for i, text in enumerate(HOMEOWNER_SAFE, 1):
        cite = cites.get(i) or {}
        steps.append(
            Step(
                index=i,
                instruction=text,
                caution=_clean_caution(cite.get("caution")),
                manual_pages=_clamp(cite.get("manual_pages"), allowed),
            )
        )

    brief = (data.get("technician_brief") or "").strip() or _fallback_brief(summary, safety)

    notes = list(safety.reasons)
    if safety.manual_scope_note:
        notes.append(f"Manual scope: {safety.manual_scope_note}")
    for note in data.get("safety_notes") or []:
        if note and note not in notes:
            notes.append(note)

    return RepairInstructions(steps=steps, safety_notes=notes, technician_brief=brief)


def _diy_result(
    data: dict[str, Any],
    safety: SafetyAssessment,
    summary: RepairSummary,
    allowed: set[int],
) -> RepairInstructions:
    raw_steps = [s for s in (data.get("steps") or []) if (s.get("instruction") or "").strip()]
    if not raw_steps or not _mentions_power_cut(raw_steps[0].get("instruction", "")):
        raw_steps.insert(0, {"instruction": POWER_FIRST, "manual_pages": [], "tools": []})

    steps = [
        Step(
            index=i,
            instruction=s["instruction"].strip(),
            caution=_clean_caution(s.get("caution")),
            tools=[t for t in (s.get("tools") or []) if t],
            manual_pages=_clamp(s.get("manual_pages"), allowed),
            figure_ref=(s.get("figure_ref") or "").strip() or None,
        )
        for i, s in enumerate(raw_steps, 1)
    ]

    notes = [n for n in (data.get("safety_notes") or []) if n]
    for reason in safety.reasons:
        if reason not in notes:
            notes.append(reason)

    return RepairInstructions(steps=steps, safety_notes=notes, technician_brief=None)


def _fallback_brief(summary: RepairSummary, safety: SafetyAssessment) -> str:
    """Used only if the model returns an empty brief; never leaves the user with nothing."""
    top = summary.top_cause
    parts = [f"Symptom: {summary.symptom_restated}"]
    if top:
        parts.append(f"Most likely cause: {top.summary}")
        if top.manual_pages:
            parts.append(f"Relevant manual pages: {', '.join(str(p) for p in top.manual_pages)}.")
    parts.append(
        "This repair requires a qualified technician: " + " ".join(safety.reasons)
    )
    return " ".join(parts)
