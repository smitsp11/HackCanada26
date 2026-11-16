"""The DIY / technician gate.

Deterministic on purpose. A model asked "is this safe for a homeowner?" will
sometimes say yes about a gas furnace, and the cost of that error is not a bad
review. This is a lookup table, and its justification is the manufacturer's own
service-scope statement captured at ingestion time.

For the Carrier 59SC6A that statement reads: "Only trained and qualified
personnel should install, repair, or service heating equipment. Untrained
personnel can perform basic maintenance functions such as cleaning and
replacing air filters. All other operations must be performed by trained
service personnel."

So the homeowner surface is small and explicit, and everything else routes out.
"""

from __future__ import annotations

from app.schemas.contracts import HazardClass, SafetyAssessment, Verdict

# Hazard classes that send a repair to a professional on their own.
BLOCKING: set[HazardClass] = {
    HazardClass.GAS,
    HazardClass.SEALED_REFRIGERANT,
    HazardClass.WATER_HEATER,
    HazardClass.COMBUSTION_VENTING,
}

_REASONS = {
    HazardClass.GAS: "Gas-fired appliance: fuel connections, burners and the gas valve are not homeowner-serviceable.",
    HazardClass.SEALED_REFRIGERANT: "Sealed refrigerant circuit: servicing requires certification and recovery equipment.",
    HazardClass.WATER_HEATER: "Water heater: combustion, scalding and pressure-relief hazards.",
    HazardClass.COMBUSTION_VENTING: "Combustion venting: incorrect work here can vent carbon monoxide into the living space.",
    HazardClass.HIGH_VOLTAGE: "Line-voltage wiring is present; disconnect power before any access.",
}

# What a homeowner may do regardless of verdict, per typical manual scope
# language. Surfaced alongside a technician verdict so the answer is still
# useful rather than just a refusal.
HOMEOWNER_SAFE = [
    "Check and replace the air filter",
    "Confirm the thermostat is calling for heat and has working batteries",
    "Confirm the circuit breaker and the furnace power switch are on",
    "Confirm the gas supply valve is open",
    "Check that the condensate drain is not blocked and the trap is not frozen",
    "Read the status/error code from the control board display",
]


def parse_hazards(raw: list[str] | None) -> list[HazardClass]:
    out: list[HazardClass] = []
    for h in raw or []:
        try:
            hc = HazardClass(str(h).strip().lower())
        except ValueError:
            continue
        if hc is not HazardClass.NONE and hc not in out:
            out.append(hc)
    return out


def assess(
    hazards: list[HazardClass],
    *,
    appliance_type: str | None = None,
    scope_note: str | None = None,
    scope_pages: list[int] | None = None,
    identified: bool = True,
) -> SafetyAssessment:
    """Decide the verdict from hazard classes alone. No model involved."""
    blocking = [h for h in hazards if h in BLOCKING]
    reasons = [_REASONS[h] for h in blocking]

    if not identified:
        # Unknown appliance means unknown hazards. Default to caution.
        return SafetyAssessment(
            verdict=Verdict.TECHNICIAN,
            hazards=hazards,
            reasons=[
                "The appliance could not be identified, so its hazards are unknown. "
                "Treat this as professional work until the model is confirmed."
            ],
            manual_scope_note=scope_note,
            manual_pages=scope_pages or [],
        )

    if blocking:
        return SafetyAssessment(
            verdict=Verdict.TECHNICIAN,
            hazards=hazards,
            reasons=reasons,
            manual_scope_note=scope_note,
            manual_pages=scope_pages or [],
        )

    notes = [_REASONS[h] for h in hazards if h in _REASONS]
    return SafetyAssessment(
        verdict=Verdict.DIY,
        hazards=hazards,
        reasons=notes or ["No blocking hazard class for this appliance type."],
        manual_scope_note=scope_note,
        manual_pages=scope_pages or [],
    )
