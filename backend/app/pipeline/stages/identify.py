"""Identify stage: photo of a data plate -> a validated appliance identity.

Two steps, and the second is the one that matters. Reading the plate is a vision
task the model does well. Checking the result against the catalog is what
catches the failure mode that actually hurts: a confident misread (O for 0, I
for 1) that would otherwise drive an entire wrong diagnosis without ever
looking wrong.

A model number that isn't in `appliances` downgrades the identity level rather
than being silently trusted.
"""

from __future__ import annotations

import re
from typing import Any, Optional

from app.config import settings
from app.core import db, llm
from app.schemas.contracts import ApplianceIdentity, IdentityLevel

PLATE_SCHEMA = {
    "type": "object",
    "properties": {
        "brand": {"type": "string"},
        "model_number": {
            "type": "string",
            "description": "The model number exactly as printed, e.g. 59SC6A",
        },
        "unit_number": {
            "type": "string",
            "description": "Fuller unit/serial-family designation if printed, e.g. 59SC6A060M17--16",
        },
        "serial": {"type": "string"},
        "appliance_type": {"type": "string"},
        "plate_found": {
            "type": "boolean",
            "description": "False if none of these images shows a data/rating plate.",
        },
        "confidence": {"type": "number"},
        "notes": {"type": "string"},
    },
    "required": ["plate_found", "confidence"],
    "additionalProperties": False,
}

PROMPT = """One or more photos of a household appliance are attached. At most one
of them shows the data plate / rating plate / nameplate.

Read that plate and report exactly what is printed on it. Do not infer, complete
or correct a model number from your own knowledge of the manufacturer - if a
character is unreadable, lower your confidence instead of guessing.

If none of the images shows a plate, set plate_found to false and leave the
other fields out."""


def normalize_model(s: Optional[str]) -> str:
    return re.sub(r"[^A-Z0-9]", "", (s or "").upper())


async def lookup(brand: Optional[str], *candidates: Optional[str]) -> Optional[dict[str, Any]]:
    """Resolve a plate reading to a catalog row, most specific match first.

    Tries each candidate string exactly, then falls back to prefix matching so a
    plate reading of 59SC6A060M17--16 still finds the 59SC6A family when the
    exact unit was never catalogued.
    """
    norms = [normalize_model(c) for c in candidates if normalize_model(c)]
    if not norms:
        return None

    # Longest first: an exact unit match beats a series match.
    for norm in sorted(set(norms), key=len, reverse=True):
        row = await db.fetchrow(
            """SELECT a.*, m.scope_note, m.scope_pages, m.page_count
                 FROM appliances a LEFT JOIN manuals m ON m.manual_id = a.manual_id
                WHERE a.model_normalized = $1
                  AND ($2::text IS NULL OR lower(a.brand) = lower($2))
                LIMIT 1""",
            norm,
            brand,
        )
        if row:
            return dict(row)

    # Series fallback: the catalogued model is a prefix of what we read.
    for norm in sorted(set(norms), key=len, reverse=True):
        row = await db.fetchrow(
            """SELECT a.*, m.scope_note, m.scope_pages, m.page_count
                 FROM appliances a LEFT JOIN manuals m ON m.manual_id = a.manual_id
                WHERE $1 LIKE a.model_normalized || '%'
                  AND ($2::text IS NULL OR lower(a.brand) = lower($2))
                ORDER BY length(a.model_normalized) DESC
                LIMIT 1""",
            norm,
            brand,
        )
        if row:
            return dict(row)
    return None


async def run(
    images: list[tuple[bytes, str]],
    *,
    brand_hint: Optional[str] = None,
    model_hint: Optional[str] = None,
) -> tuple[ApplianceIdentity, dict[str, Any]]:
    """Returns (identity, usage). `images` is a list of (bytes, mime_type)."""
    usage: dict[str, Any] = {}
    read: dict[str, Any] = {}

    if images:
        parts = [llm.image_part(b, m) for b, m in images] + [llm.text_part(PROMPT)]
        read, usage = await llm.llm.complete(
            parts,
            model=settings.model_default,
            system="You read appliance data plates and report only what is printed.",
            schema=PLATE_SCHEMA,
            schema_name="plate_reading",
            max_tokens=1000,
        )

    brand = read.get("brand") or brand_hint
    model_number = read.get("model_number") or model_hint
    unit_number = read.get("unit_number")

    # A user-supplied model beats a low-confidence read; they can see the plate.
    row = await lookup(brand, unit_number, model_number, model_hint)

    identity = ApplianceIdentity(
        brand=brand,
        model_number=model_number,
        unit_number=unit_number,
        model_normalized=normalize_model(unit_number or model_number),
        serial=read.get("serial"),
        appliance_type=(row or {}).get("appliance_type") or read.get("appliance_type"),
        confidence=float(read.get("confidence") or (0.6 if model_hint else 0.0)),
        notes=read.get("notes"),
        user_confirmed=bool(model_hint and not read.get("plate_found")),
    )

    if row:
        identity.catalog_matched = True
        identity.manual_id = row.get("manual_id")
        exact = normalize_model(unit_number or model_number) == row["model_normalized"]
        identity.identity_level = IdentityLevel.EXACT if exact else IdentityLevel.SERIES
        # A catalog hit is corroboration: the string we read is a real product.
        identity.confidence = max(identity.confidence, 0.9 if exact else 0.75)
    elif brand and identity.appliance_type:
        identity.identity_level = IdentityLevel.BRAND_PLUS_TYPE
    else:
        identity.identity_level = IdentityLevel.TYPE_ONLY

    return identity, usage
