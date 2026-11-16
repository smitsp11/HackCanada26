"""Diagnose stage: manual + symptom + photos -> ranked causes with page citations.

The manual goes into the request as a PDF and the provider renders its pages,
so the troubleshooting flowcharts and status-code tables - which are images, not
text, in most service manuals - are readable. That is the entire reason this
stage produces anything better than a cold guess.

Three things the prompt is built to enforce:
  - every cause cites the manual pages that support it, or admits it can't
  - abstaining is an acceptable answer
  - asking the user a question is an acceptable answer
"""

from __future__ import annotations

from typing import Any, Optional

from app.config import settings
from app.core import llm
from app.schemas.contracts import ApplianceIdentity, Cause, RepairSummary

DIAGNOSIS_SCHEMA = {
    "type": "object",
    "properties": {
        "symptom_restated": {"type": "string"},
        "abstained": {"type": "boolean"},
        "abstain_reason": {"type": "string"},
        "causes": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "summary": {"type": "string"},
                    "detail": {"type": "string"},
                    "confidence": {"type": "number"},
                    "manual_pages": {"type": "array", "items": {"type": "integer"}},
                    "evidence": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Short verbatim quotes from the cited pages.",
                    },
                    "error_codes": {"type": "array", "items": {"type": "string"}},
                    "components": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["summary", "confidence", "manual_pages", "evidence"],
                "additionalProperties": False,
            },
        },
        "clarifying_questions": {"type": "array", "items": {"type": "string"}},
        "requested_photos": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["symptom_restated", "abstained", "causes"],
    "additionalProperties": False,
}

SYSTEM = """You are an appliance diagnostic assistant working strictly from the
service manual you are given.

Rules you must follow:
- Ground every cause in the manual. Cite the page numbers you used, and quote
  the short phrases that support it.
- Prefer causes the manual explicitly documents (status codes, troubleshooting
  tables, sequences of operation) over general reasoning.
- Never invent a page number, a status code, a specification value, or a part
  number. If the manual does not say it, do not assert it.
- If the evidence does not support a diagnosis, set abstained to true and say
  what is missing. That is a correct answer, not a failure.
- If one question or one photo would materially change your answer, ask for it.
"""


def _user_prompt(identity: ApplianceIdentity, symptom: str, error_code: Optional[str]) -> str:
    unit = identity.unit_number or identity.model_number or "unknown model"
    lines = [
        f"Appliance: {identity.brand or 'unknown brand'} {unit}"
        + (f" ({identity.appliance_type})" if identity.appliance_type else ""),
        f"Identification confidence: {identity.confidence:.2f} ({identity.identity_level.value})",
        "",
        f"Reported symptom: {symptom}",
    ]
    if error_code:
        lines.append(f"Displayed code: {error_code}")
    lines += [
        "",
        "The full service manual for this appliance is attached, along with any "
        "photos the owner supplied.",
        "",
        "Diagnose the most likely causes, most likely first. For each, cite the "
        "manual pages that support it and quote the phrases you relied on. "
        "Include any status/fault codes the manual associates with this symptom "
        "and the specification values a technician would check.",
    ]
    return "\n".join(lines)


async def run(
    manual_pdf: Optional[bytes],
    identity: ApplianceIdentity,
    symptom: str,
    *,
    error_code: Optional[str] = None,
    images: Optional[list[tuple[bytes, str]]] = None,
    manual_url: Optional[str] = None,
    page_numbers: Optional[list[int]] = None,
    model: Optional[str] = None,
    reasoning: Optional[dict[str, Any]] = None,
) -> tuple[RepairSummary, dict[str, Any]]:
    """Returns (summary, usage). Without a manual, the result is ungrounded.

    `manual_url`: have the provider fetch the manual itself instead of inlining
    ~22 MB of base64 from this process on every call.
    `page_numbers`: set when `manual_pdf` is an excerpt, so citations use the
    manual's own page numbers rather than positions in the excerpt.
    """
    has_manual = bool(manual_pdf or manual_url)
    parts: list[dict[str, Any]] = []
    if manual_url:
        parts.append(llm.pdf_url_part(manual_url, "manual.pdf"))
    elif manual_pdf:
        parts.append(llm.pdf_part(manual_pdf, "manual.pdf"))
    for data, mime in images or []:
        parts.append(llm.image_part(data, mime))
    prompt = _user_prompt(identity, symptom, error_code)
    if page_numbers:
        prompt += (
            "\n\nThe attached PDF is an excerpt. Its pages are, in order, manual pages "
            + ", ".join(str(n) for n in page_numbers)
            + ". Cite those manual page numbers, not positions in the excerpt. "
            "If these pages do not cover the symptom, say so and abstain rather "
            "than guessing."
        )
    parts.append(llm.text_part(prompt))

    system = SYSTEM
    if not has_manual:
        system += (
            "\nNO MANUAL IS AVAILABLE for this appliance. Answer from general "
            "knowledge, leave manual_pages empty, and keep confidence low."
        )

    data, usage = await llm.llm.complete(
        parts,
        model=model or settings.model_diagnose,
        system=system,
        schema=DIAGNOSIS_SCHEMA,
        schema_name="diagnosis",
        max_tokens=settings.diagnose_max_tokens,
        has_pdf=has_manual,
        reasoning=reasoning,
        timeout=settings.diagnose_timeout_s,
    )

    causes = [
        Cause(
            summary=c["summary"],
            detail=c.get("detail"),
            confidence=float(c.get("confidence") or 0.0),
            # On an excerpt, a page that was never sent cannot have been read.
            manual_pages=[
                p for p in (c.get("manual_pages") or [])
                if not page_numbers or p in page_numbers
            ],
            evidence=c.get("evidence") or [],
            error_codes=c.get("error_codes") or [],
            components=c.get("components") or [],
        )
        for c in (data.get("causes") or [])
    ]
    causes.sort(key=lambda c: c.confidence, reverse=True)

    return (
        RepairSummary(
            symptom_restated=data.get("symptom_restated") or symptom,
            causes=causes,
            abstained=bool(data.get("abstained")),
            abstain_reason=data.get("abstain_reason"),
            clarifying_questions=data.get("clarifying_questions") or [],
            requested_photos=data.get("requested_photos") or [],
            grounded=has_manual and any(c.manual_pages for c in causes),
        ),
        usage,
    )
