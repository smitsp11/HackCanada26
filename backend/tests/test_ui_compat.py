"""Tests for the frontend compatibility translator.

Pure and offline: no database, no model calls. Built from the real recorded
diagnosis in tests/golden so the payloads are realistic.

The central property under test is that the frontend can never hang. Its phase
machine has two gates - `parts_check_complete` and `synthesis_complete` - and
waits on each indefinitely. So every scenario below, including every upstream
failure, is run through a model of that phase machine and must end in either
COMPLETE or ERROR.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.api.ui_compat import UiTranslator

GOLDEN = json.loads(
    (Path(__file__).parent / "golden/furnace_ignition_lockout_with_code.json").read_text()
)
IDENTITY = GOLDEN["identity"]
SUMMARY = GOLDEN["summary"]
SAFETY = SUMMARY["safety"]

PARTS = {
    "parts": [
        {"name": "Gas valve", "part_number": None, "manual_pages": [72, 74],
         "search_url": "https://example/", "note": None},
        {"name": "Circuit board", "part_number": None, "manual_pages": [72],
         "search_url": "https://example/", "note": None},
    ],
    "numbers_unavailable": True,
}
INSTRUCTIONS = {
    "steps": [
        {"index": 1, "instruction": "Check and replace the air filter",
         "caution": None, "tools": [], "manual_pages": [63]},
        {"index": 2, "instruction": "Confirm the gas supply valve is open",
         "caution": "Do not relight if you smell gas", "tools": [], "manual_pages": [58]},
    ],
    "safety_notes": [],
    "technician_brief": "Code 34.1. Verify inlet gas pressure 4.5-13.6 in. w.c. and 24V at the gas valve.",
}


def ev(seq: int, type_: str, payload: dict) -> dict:
    return {"seq": seq, "type": type_, "payload": payload}


def full_run(*, parts_ok=True, instruct_ok=True, diagnose_ok=True) -> list[dict]:
    """Internal events, in the order the runner actually emits them."""
    seq = iter(range(1, 100))
    out = [
        ev(next(seq), "case_status", {"status": "processing"}),
        ev(next(seq), "stage_started", {"stage": "identify"}),
        ev(next(seq), "stage_completed", {"stage": "identify", "output": IDENTITY}),
        ev(next(seq), "identity_resolved", {"identity": IDENTITY}),
        ev(next(seq), "safety_verdict", SAFETY),
        ev(next(seq), "stage_started", {"stage": "diagnose"}),
    ]
    if not diagnose_ok:
        out.append(ev(next(seq), "error", {"stage": "diagnose", "error": "model timeout"}))
        out.append(ev(next(seq), "case_status", {"status": "failed"}))
        return out
    out += [
        ev(next(seq), "stage_completed", {"stage": "diagnose", "output": SUMMARY}),
        ev(next(seq), "diagnosis_complete", {"summary": SUMMARY}),
        ev(next(seq), "stage_started", {"stage": "parts"}),
    ]
    out.append(
        ev(next(seq), "stage_completed", {"stage": "parts", "output": PARTS}) if parts_ok
        else ev(next(seq), "error", {"stage": "parts", "error": "parts lookup failed"})
    )
    out.append(ev(next(seq), "stage_started", {"stage": "instruct"}))
    out.append(
        ev(next(seq), "stage_completed", {"stage": "instruct", "output": INSTRUCTIONS}) if instruct_ok
        else ev(next(seq), "error", {"stage": "instruct", "error": "instruct failed"})
    )
    out.append(ev(next(seq), "case_status", {"status": "ready"}))
    return out


def translate(events: list[dict], terminal_status: str) -> list[dict]:
    t = UiTranslator(manual_titles={"carrier-59sc6a": "59SC6A Service Manual"})
    ui = []
    for e in events:
        ui += t.feed(e)
    ui += t.finalize(terminal_status)
    return ui


class FrontendPhaseModel:
    """The phase transitions from hackcanada-next-ui/hooks/useOperaReducer.ts.

    Only the transitions that gate progress are modelled; everything else the
    reducer does is display state. If this model cannot reach COMPLETE or ERROR,
    neither can the real UI.
    """

    def __init__(self):
        self.phase = "PHASE_1_INGESTION"  # set by UPLOAD_COMPLETE before SSE opens
        self.slots_complete = 0
        self.repair_steps = None
        self.error = None

    def apply(self, e: dict) -> None:
        t = e["type"]
        if t == "slot_complete":
            self.slots_complete += 1
            if self.slots_complete == 3 and self.phase == "PHASE_1_INGESTION":
                self.phase = "PHASE_2_COGNITIVE"  # OperaShell's 4500ms timer
        elif t == "case_status":
            # Reducer calls .toUpperCase() on it - must be a non-null string.
            assert isinstance(e["status"], str) and e["status"]
            if e["status"] == "analyzing" and self.phase == "PHASE_1_INGESTION":
                self.phase = "PHASE_2_COGNITIVE"
        elif t == "parts_check_complete":
            if self.phase == "PHASE_2_COGNITIVE":
                self.phase = "PHASE_3_SYNTHESIS"  # Phase2Cognitive -> MANUAL_RETRIEVED
        elif t == "synthesis_complete":
            self.phase = "COMPLETE"
            self.repair_steps = e["steps"]
        elif t == "error":
            self.phase = "ERROR"
            self.error = e["message"]

    def run(self, events: list[dict]) -> "FrontendPhaseModel":
        for e in events:
            self.apply(e)
        return self


# ---------------------------------------------------------------------------
# The never-hang property
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "scenario, kwargs, terminal",
    [
        ("happy path", {}, "ready"),
        ("parts stage fails", {"parts_ok": False}, "ready"),
        ("instruct stage fails", {"instruct_ok": False}, "ready"),
        ("parts and instruct both fail", {"parts_ok": False, "instruct_ok": False}, "ready"),
    ],
)
def test_frontend_always_reaches_complete(scenario, kwargs, terminal):
    ui = translate(full_run(**kwargs), terminal)
    model = FrontendPhaseModel().run(ui)
    assert model.phase == "COMPLETE", f"{scenario}: UI stuck in {model.phase}"
    assert model.repair_steps, f"{scenario}: completed with no steps to show"


def test_diagnosis_failure_reaches_error_not_a_hang():
    ui = translate(full_run(diagnose_ok=False), "failed")
    model = FrontendPhaseModel().run(ui)
    assert model.phase == "ERROR"
    assert model.error


def test_failure_before_any_event_still_terminates():
    """Runner died before emitting anything useful."""
    ui = translate([ev(1, "case_status", {"status": "processing"})], "failed")
    assert FrontendPhaseModel().run(ui).phase == "ERROR"


# ---------------------------------------------------------------------------
# Gates fire exactly once
# ---------------------------------------------------------------------------


def test_gates_fire_exactly_once_on_the_happy_path():
    ui = translate(full_run(), "ready")
    assert sum(e["type"] == "parts_check_complete" for e in ui) == 1
    assert sum(e["type"] == "synthesis_complete" for e in ui) == 1


def test_replayed_events_do_not_duplicate_gates():
    """A reconnect replays history from seq 0 into the same stream."""
    events = full_run()
    t = UiTranslator()
    ui = []
    for e in events + events:
        ui += t.feed(e)
    ui += t.finalize("ready")
    assert sum(e["type"] == "parts_check_complete" for e in ui) == 1
    assert sum(e["type"] == "synthesis_complete" for e in ui) == 1


def test_finalize_after_success_emits_nothing_more():
    t = UiTranslator()
    for e in full_run():
        t.feed(e)
    assert t.finalize("ready") == []


# ---------------------------------------------------------------------------
# Wire format the client depends on
# ---------------------------------------------------------------------------


def test_every_frame_has_a_string_type():
    for e in translate(full_run(), "ready"):
        assert isinstance(e.get("type"), str) and e["type"]


def test_client_field_names_are_camel_case():
    ui = translate(full_run(), "ready")
    by = {e["type"]: e for e in ui}
    assert "makeModel" in by["device_identified"]
    assert {"manualId", "title"} <= set(by["manual_found"])
    assert {"symptom", "sections"} <= set(by["symptom_sections_found"])
    assert isinstance(by["symptom_sections_found"]["sections"], str)
    assert isinstance(by["parts_check_complete"]["parts"], str)
    for p in (e for e in ui if e["type"] == "synthesis_progress"):
        assert isinstance(p["percent"], int) and isinstance(p["log"], str)


def test_steps_match_the_client_repair_step_shape():
    steps = next(e for e in translate(full_run(), "ready")
                 if e["type"] == "synthesis_complete")["steps"]
    assert [s["id"] for s in steps] == list(range(1, len(steps) + 1))
    for s in steps:
        assert set(s) == {"id", "instruction", "schematicUrl"}
        assert isinstance(s["id"], int)
        assert isinstance(s["instruction"], str) and s["instruction"]
        assert s["schematicUrl"] is None


def test_progress_never_goes_backwards_past_the_end():
    pcts = [e["percent"] for e in translate(full_run(), "ready")
            if e["type"] == "synthesis_progress"]
    assert pcts[-1] == 100
    assert all(0 <= p <= 100 for p in pcts)


# ---------------------------------------------------------------------------
# Content: grounding and safety survive the flattening
# ---------------------------------------------------------------------------


def test_device_and_manual_reported():
    by = {e["type"]: e for e in translate(full_run(), "ready")}
    assert by["device_identified"]["makeModel"] == "Carrier 59SC6A060M17--16"
    assert by["manual_found"]["manualId"] == "carrier-59sc6a"
    assert by["manual_found"]["title"] == "59SC6A Service Manual"


def test_technician_verdict_leads_the_steps_with_the_manufacturer_quote():
    steps = next(e for e in translate(full_run(), "ready")
                 if e["type"] == "synthesis_complete")["steps"]
    first = steps[0]["instruction"]
    assert "licensed technician" in first
    assert "Only trained and qualified personnel" in first
    assert "manual p.4" in first


def test_citations_are_folded_into_step_text():
    """The client has no citation field, so grounding must survive in the text."""
    steps = next(e for e in translate(full_run(), "ready")
                 if e["type"] == "synthesis_complete")["steps"]
    text = " ".join(s["instruction"] for s in steps)
    assert "manual p.63" in text and "manual p.58" in text


def test_technician_brief_is_the_last_step():
    steps = next(e for e in translate(full_run(), "ready")
                 if e["type"] == "synthesis_complete")["steps"]
    assert steps[-1]["instruction"].startswith("Tell your technician:")


def test_parts_text_admits_numbers_are_unavailable():
    parts = next(e for e in translate(full_run(), "ready")
                 if e["type"] == "parts_check_complete")["parts"]
    assert "Gas valve" in parts
    assert "not printed in this manual" in parts


def test_instruct_failure_falls_back_to_the_diagnosis():
    steps = next(e for e in translate(full_run(instruct_ok=False), "ready")
                 if e["type"] == "synthesis_complete")["steps"]
    text = [s["instruction"] for s in steps]
    assert any(s.startswith("Most likely cause:") for s in text)
    assert any(s.startswith("Other possible cause:") for s in text)


def test_parts_failure_falls_back_to_components_named_in_diagnosis():
    parts = next(e for e in translate(full_run(parts_ok=False), "ready")
                 if e["type"] == "parts_check_complete")["parts"]
    assert parts and parts != "No specific parts identified"


def test_input_accepts_the_frontend_dialect():
    from app.api.cases import _InputBody

    body = _InputBody(description="no heat", metadata={"brand": "Carrier", "model": "59SC6A"},
                      assets=[]).normalized()
    assert body.symptom == "no heat"
    assert (body.brand_hint, body.model_hint) == ("Carrier", "59SC6A")


def test_input_rejects_an_empty_symptom():
    from fastapi import HTTPException

    from app.api.cases import _InputBody

    with pytest.raises(HTTPException):
        _InputBody(description="   ").normalized()


def test_diagnosis_is_step_two_under_a_technician_verdict():
    steps = next(e for e in translate(full_run(), "ready")
                 if e["type"] == "synthesis_complete")["steps"]
    assert steps[1]["instruction"].startswith("Most likely cause:")


def test_instruct_finishing_first_still_shows_the_real_parts_list():
    """Parts and instruct run concurrently; instruct may land first."""
    events = full_run()
    parts_ev = next(e for e in events if e["type"] == "stage_completed"
                    and e["payload"]["stage"] == "parts")
    instr_ev = next(e for e in events if e["type"] == "stage_completed"
                    and e["payload"]["stage"] == "instruct")
    i, j = events.index(parts_ev), events.index(instr_ev)
    events[i], events[j] = events[j], events[i]
    ui = translate(events, "ready")
    gate = next(e for e in ui if e["type"] == "parts_check_complete")
    assert "Gas valve" in gate["parts"], "fallback text shown instead of the real parts list"
    assert [e["type"] for e in ui].index("parts_check_complete") < \
           [e["type"] for e in ui].index("synthesis_complete")
    assert FrontendPhaseModel().run(ui).phase == "COMPLETE"


def test_instruct_error_before_parts_waits_for_parts():
    events = [e for e in full_run(instruct_ok=False)]
    parts_ev = next(e for e in events if e["type"] == "stage_completed"
                    and e["payload"]["stage"] == "parts")
    err = next(e for e in events if e["type"] == "error" and e["payload"]["stage"] == "instruct")
    i, j = events.index(parts_ev), events.index(err)
    events[i], events[j] = events[j], events[i]
    ui = translate(events, "ready")
    gate = next(e for e in ui if e["type"] == "parts_check_complete")
    assert "Gas valve" in gate["parts"]
    assert FrontendPhaseModel().run(ui).phase == "COMPLETE"
