"""Phase A vertical slice, run end to end against the real fixtures.

    ./.venv/bin/python -m tests.phase_a

identify -> catalog validation -> safety gate -> diagnose, with the full manual
in context. Prints what a user would see. Costs a few cents per run.
"""

from __future__ import annotations

import asyncio
import mimetypes
import sys
import time
from pathlib import Path

from app.core import db, storage
from app.pipeline import safety
from app.pipeline.stages import diagnose, identify

FIXTURES = Path("fixtures")
SYMPTOM = (
    "The furnace is not producing heat. It sounds like it tries to start - the "
    "fan spins up and I hear a click - but no flame comes on, and after a few "
    "tries it gives up completely. The little light on the control board is blinking."
)


def load_images() -> list[tuple[bytes, str]]:
    out = []
    for p in sorted(FIXTURES.glob("*")):
        mime = mimetypes.guess_type(p.name)[0] or ""
        if mime.startswith("image/"):
            out.append((p.read_bytes(), mime))
    return out


def rule(title: str) -> None:
    print(f"\n{'=' * 64}\n{title}\n{'=' * 64}")


async def main() -> int:
    await db.init_pool()
    total_cost = 0.0
    try:
        images = load_images()
        print(f"fixtures: {len(images)} images")

        # ---- identify -------------------------------------------------
        rule("IDENTIFY")
        t = time.time()
        ident, usage = await identify.run(images)
        total_cost += usage.get("cost") or 0
        print(f"brand            {ident.brand}")
        print(f"model            {ident.model_number}")
        print(f"unit             {ident.unit_number}")
        print(f"serial           {ident.serial}")
        print(f"type             {ident.appliance_type}")
        print(f"confidence       {ident.confidence:.2f}")
        print(f"identity level   {ident.identity_level.value}")
        print(f"catalog matched  {ident.catalog_matched}   manual={ident.manual_id}")
        print(f"({time.time()-t:.1f}s, ${usage.get('cost',0):.4f})")

        if not ident.manual_id:
            print("\nno manual resolved - diagnosis would be ungrounded")

        # ---- manual + safety gate -------------------------------------
        manual_row = None
        manual_pdf = None
        if ident.manual_id:
            manual_row = await db.fetchrow(
                "SELECT * FROM manuals WHERE manual_id=$1", ident.manual_id
            )
            local = Path("manuals/opera-manual.pdf")
            manual_pdf = (
                local.read_bytes() if local.exists()
                else await storage.download(manual_row["pdf_path"])
            )

        rule("SAFETY GATE")
        hazards = safety.parse_hazards(
            (await db.fetchval(
                "SELECT attributes->'hazard_classes' FROM appliances WHERE manual_id=$1 LIMIT 1",
                ident.manual_id,
            )) if ident.manual_id else []
        )
        assessment = safety.assess(
            hazards,
            appliance_type=ident.appliance_type,
            scope_note=manual_row["scope_note"] if manual_row else None,
            scope_pages=list(manual_row["scope_pages"] or []) if manual_row else [],
            identified=bool(ident.manual_id),
        )
        print(f"verdict   {assessment.verdict.value.upper()}")
        print(f"hazards   {[h.value for h in assessment.hazards]}")
        for r in assessment.reasons:
            print(f"  - {r}")
        if assessment.manual_scope_note:
            print(f"manual says (p.{assessment.manual_pages}):")
            print(f"  \"{assessment.manual_scope_note[:200]}\"")

        # ---- diagnose --------------------------------------------------
        rule("DIAGNOSE")
        print(f"symptom: {SYMPTOM}\n")
        t = time.time()
        summary, usage = await diagnose.run(
            manual_pdf, ident, SYMPTOM, images=images
        )
        total_cost += usage.get("cost") or 0

        print(f"grounded: {summary.grounded}   abstained: {summary.abstained}")
        if summary.abstain_reason:
            print(f"abstain reason: {summary.abstain_reason}")
        for i, c in enumerate(summary.causes, 1):
            print(f"\n{i}. [{c.confidence:.2f}] {c.summary}")
            if c.detail:
                print(f"   {c.detail[:300]}")
            if c.error_codes:
                print(f"   codes: {', '.join(c.error_codes)}")
            if c.components:
                print(f"   parts: {', '.join(c.components)}")
            print(f"   manual pages: {c.manual_pages}")
            for q in c.evidence[:2]:
                print(f"   > {q[:170]}")
        if summary.clarifying_questions:
            print("\nwould ask the user:")
            for q in summary.clarifying_questions:
                print(f"  ? {q}")
        if summary.requested_photos:
            print("\nwould request photos of:")
            for q in summary.requested_photos:
                print(f"  + {q}")
        print(f"\n({time.time()-t:.1f}s, ${usage.get('cost',0):.4f})")

        rule("TOTAL")
        print(f"${total_cost:.4f} per case")
        return 0
    finally:
        await db.close_pool()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
