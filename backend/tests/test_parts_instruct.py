"""Assertions over the parts and instruct stages.

    ./.venv/bin/python -m pytest tests/test_parts_instruct.py -v

Free and offline by default: the contract objects are rebuilt from the recorded
diagnosis in tests/golden/, and the model call is replaced by a stub whose
answers are deliberately hostile - a fabricated part number, a URL the model
was never allowed to emit, a DIY procedure that forgets to kill the power. What
is being tested is the code that catches those, not the model.

Two live calls exist for the real furnace case and are opt-in, because each one
costs a few cents and takes 30-90s:

    OPERA_LIVE=1 ./.venv/bin/python -m pytest tests/test_parts_instruct.py -v
"""

from __future__ import annotations

import asyncio
import io
import json
import os
import re
from pathlib import Path
from urllib.parse import urlparse

import pytest
from pypdf import PdfReader

from app.core import llm as llm_mod
from app.pipeline.safety import HOMEOWNER_SAFE
from app.pipeline.stages import instruct, parts
from app.schemas.contracts import (
    ApplianceIdentity,
    Cause,
    RepairSummary,
    SafetyAssessment,
    Verdict,
)

HERE = Path(__file__).parent
GOLDEN = HERE / "golden" / "furnace_ignition_lockout_with_code.json"
MANUAL = Path("manuals/opera-manual.pdf")
LIVE = os.getenv("OPERA_LIVE") == "1"


# ---------------------------------------------------------------------------
# Fixtures built from the recording
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def recorded() -> dict:
    if not GOLDEN.exists():
        pytest.skip("no recorded diagnosis - run: python -m tests.record")
    return json.loads(GOLDEN.read_text())


@pytest.fixture(scope="session")
def manual_bytes() -> bytes:
    if not MANUAL.exists():
        pytest.skip(f"{MANUAL} not present")
    return MANUAL.read_bytes()


@pytest.fixture(scope="session")
def manual_text(manual_bytes) -> str:
    reader = PdfReader(io.BytesIO(manual_bytes))
    return re.sub(r"[^A-Z0-9]", "", " ".join(p.extract_text() or "" for p in reader.pages).upper())


@pytest.fixture
def identity(recorded) -> ApplianceIdentity:
    return ApplianceIdentity(**recorded["identity"])


@pytest.fixture
def summary(recorded) -> RepairSummary:
    s = recorded["summary"]
    return RepairSummary(
        symptom_restated=s["symptom_restated"],
        causes=[Cause(**c) for c in s["causes"]],
        abstained=s["abstained"],
        grounded=s["grounded"],
        safety=SafetyAssessment(**s["safety"]),
    )


@pytest.fixture
def tech_safety(summary) -> SafetyAssessment:
    assert summary.safety.verdict is Verdict.TECHNICIAN, "the recorded case must be a gas furnace"
    return summary.safety


@pytest.fixture
def diy_safety() -> SafetyAssessment:
    return SafetyAssessment(
        verdict=Verdict.DIY,
        hazards=[],
        reasons=["No blocking hazard class for this appliance type."],
        manual_pages=[4],
    )


def stub_llm(monkeypatch, payload: dict) -> list[dict]:
    """Replace the model with a canned answer. Returns the captured requests."""
    seen: list[dict] = []

    async def fake_complete(parts_msg, **kwargs):
        seen.append({"parts": parts_msg, **kwargs})
        return payload, {"model": "stub", "total_tokens": 0}

    monkeypatch.setattr(llm_mod.llm, "complete", fake_complete)
    return seen


def is_http_url(url: str) -> bool:
    parsed = urlparse(url or "")
    return parsed.scheme in ("http", "https") and bool(parsed.netloc)


# ---------------------------------------------------------------------------
# Parts: numbers are facts, not guesses
# ---------------------------------------------------------------------------


HOSTILE_PARTS = {
    "parts_list_style": "numbered",
    "parts": [
        # Real: page 40 prints this one.
        {"name": "Inducer outlet restrictor", "part_number": "337683-401", "manual_pages": [40]},
        # Fabricated: the shape is right, the manual has never seen it.
        {"name": "Gas valve", "part_number": "HK42FZ011", "manual_pages": [74]},
        {"name": "Hot surface igniter", "part_number": "LH33ZS002", "manual_pages": [74],
         "note": "Replace with the same part."},
        # Honest: no number, which is what this manual mostly supports.
        {"name": "Flame sensor", "manual_pages": [74]},
        # A page the excerpt never contained, and a duplicate name.
        {"name": "Circuit board", "manual_pages": [3, 74]},
        {"name": "gas valve", "part_number": "9999", "manual_pages": [74]},
    ],
}


@pytest.fixture
def stub_parts_list(monkeypatch, manual_bytes, identity, summary):
    stub_llm(monkeypatch, HOSTILE_PARTS)
    return asyncio.run(parts.run(manual_bytes, identity, summary))[0]


def test_part_numbers_all_appear_in_the_manual(stub_parts_list, manual_text):
    for part in stub_parts_list.parts:
        if part.part_number is None:
            continue
        norm = re.sub(r"[^A-Z0-9]", "", part.part_number.upper())
        assert norm in manual_text, f"{part.name}: {part.part_number!r} is not in the manual"


def test_fabricated_numbers_are_suppressed_with_a_note(stub_parts_list):
    by_name = {p.name.lower(): p for p in stub_parts_list.parts}
    assert by_name["inducer outlet restrictor"].part_number == "337683-401"
    for name in ("gas valve", "hot surface igniter"):
        assert by_name[name].part_number is None, f"{name} kept a fabricated number"
        assert "withheld" in (by_name[name].note or "")


def test_every_part_has_a_well_formed_search_url(stub_parts_list, identity):
    assert stub_parts_list.parts
    for part in stub_parts_list.parts:
        assert is_http_url(part.search_url), f"{part.name}: {part.search_url!r}"
        assert identity.brand.lower() in part.search_url.lower()


def test_search_urls_are_never_taken_from_the_model(monkeypatch, manual_bytes, identity, summary):
    """A model-supplied URL must not survive into the output, whatever it says."""
    payload = dict(HOSTILE_PARTS)
    payload["parts"] = [
        {"name": "Gas valve", "manual_pages": [74], "search_url": "https://evil.example/buy"}
    ]
    stub_llm(monkeypatch, payload)
    result, _ = asyncio.run(parts.run(manual_bytes, identity, summary))
    assert "evil.example" not in json.dumps(result.model_dump())


def test_cited_pages_are_restricted_to_what_was_sent(stub_parts_list):
    board = next(p for p in stub_parts_list.parts if p.name == "Circuit board")
    assert 3 not in board.manual_pages, "a page the model was never shown was accepted"
    assert 74 in board.manual_pages


def test_group_list_manual_reports_numbers_unavailable(stub_parts_list):
    """Page 74 lists parts by group name with no numbers, so this must be true."""
    assert stub_parts_list.numbers_unavailable is True


def test_parts_without_a_manual_fall_back_to_named_components(identity, summary):
    result, usage = asyncio.run(parts.run(None, identity, summary))
    assert usage == {}, "no manual means no model call"
    assert result.numbers_unavailable is True
    assert result.parts and all(p.part_number is None for p in result.parts)
    assert all(is_http_url(p.search_url) for p in result.parts)


# ---------------------------------------------------------------------------
# Verification wiring
# ---------------------------------------------------------------------------


def test_verify_summary_marks_every_cause(summary, manual_bytes):
    assert all(c.verified is None for c in summary.causes)
    marked = asyncio.run(parts.verify_summary(summary, manual_bytes))
    assert len(marked.causes) == len(summary.causes), "causes must never be dropped"
    assert all(isinstance(c.verified, bool) for c in marked.causes)
    assert any(c.verified for c in marked.causes), "the recorded diagnosis should verify"


def test_verify_summary_marks_an_invented_citation_false(summary, manual_bytes):
    summary.causes.append(
        Cause(
            summary="Fabricated cause",
            confidence=0.1,
            manual_pages=[9999],
            evidence=["a sentence that is nowhere in this manual at all"],
        )
    )
    marked = asyncio.run(parts.verify_summary(summary, manual_bytes))
    assert marked.causes[-1].verified is False


def test_verify_summary_without_a_manual_leaves_causes_unmarked(summary):
    marked = asyncio.run(parts.verify_summary(summary, None))
    assert all(c.verified is None for c in marked.causes)


# ---------------------------------------------------------------------------
# Instruct: the technician branch
# ---------------------------------------------------------------------------


STUB_TECH = {
    "technician_brief": "Code 34.1 is an ignition proving failure. Verify 24V at the gas "
    "valve during trial for ignition and confirm inlet pressure holds above 4.5 in. w.c. "
    "See pages 58 and 72.",
    "safety_notes": ["Turn off the gas supply before any burner work."],
    "homeowner_checks": [
        {"check_index": 1, "manual_pages": [65], "caution": "Do not run the furnace without a filter."},
        {"check_index": 6, "manual_pages": [72, 3]},
    ],
}


@pytest.fixture
def stub_tech_instructions(monkeypatch, manual_bytes, identity, summary, tech_safety):
    calls = stub_llm(monkeypatch, STUB_TECH)
    result, _ = asyncio.run(instruct.run(manual_bytes, identity, summary, tech_safety))
    return result, calls


def test_technician_verdict_produces_a_brief(stub_tech_instructions):
    result, _ = stub_tech_instructions
    assert result.technician_brief and "34.1" in result.technician_brief
    assert result.safety_notes


def test_technician_verdict_produces_no_repair_steps(stub_tech_instructions):
    """The only steps allowed are the homeowner-safe checks, verbatim."""
    result, _ = stub_tech_instructions
    assert [s.instruction for s in result.steps] == HOMEOWNER_SAFE
    assert [s.index for s in result.steps] == list(range(1, len(HOMEOWNER_SAFE) + 1))


def test_technician_steps_carry_citations_and_no_illustrations(stub_tech_instructions):
    result, _ = stub_tech_instructions
    assert result.steps[0].manual_pages == [65]
    assert result.steps[0].caution
    # Page 3 was never sent, so it must not survive into a citation.
    assert result.steps[5].manual_pages == [72]
    assert all(s.illustration_key is None for s in result.steps)


def test_technician_prompt_forbids_repair_steps(stub_tech_instructions):
    result, calls = stub_tech_instructions
    system = calls[0]["system"].lower()
    assert "must not write repair steps" in system
    assert "steps" not in calls[0]["schema"]["properties"], "the schema must have no room for steps"


def test_technician_brief_falls_back_when_the_model_returns_nothing(
    monkeypatch, manual_bytes, identity, summary, tech_safety
):
    stub_llm(monkeypatch, {"technician_brief": "", "safety_notes": [], "homeowner_checks": []})
    result, _ = asyncio.run(instruct.run(manual_bytes, identity, summary, tech_safety))
    assert result.technician_brief
    assert summary.top_cause.summary in result.technician_brief


# ---------------------------------------------------------------------------
# Instruct: the DIY branch
# ---------------------------------------------------------------------------


STUB_DIY_NO_POWER_STEP = {
    "steps": [
        {"instruction": "Remove the blower door.", "manual_pages": [72], "tools": ["nut driver"]},
        {
            "instruction": "Inspect the condensate trap for blockage.",
            "manual_pages": [65],
            "figure_ref": "Fig. 68",
            "caution": "Water may spill.",
        },
    ],
    "safety_notes": ["Wear gloves; sheet metal edges are sharp."],
}


def _diy(monkeypatch, manual_bytes, identity, summary, diy_safety, payload):
    stub_llm(monkeypatch, payload)
    return asyncio.run(instruct.run(manual_bytes, identity, summary, diy_safety))[0]


def test_diy_first_step_is_always_disconnecting_power(
    monkeypatch, manual_bytes, identity, summary, diy_safety
):
    result = _diy(monkeypatch, manual_bytes, identity, summary, diy_safety, STUB_DIY_NO_POWER_STEP)
    first = result.steps[0].instruction.lower()
    assert "power" in first and "disconnect" in first
    assert result.steps[1].instruction.startswith("Remove the blower door")
    assert [s.index for s in result.steps] == [1, 2, 3]
    assert result.technician_brief is None


def test_diy_does_not_duplicate_a_power_step_the_model_already_wrote(
    monkeypatch, manual_bytes, identity, summary, diy_safety
):
    payload = {
        "steps": [
            {"instruction": "Disconnect electrical power at the breaker.", "manual_pages": [4]},
            {"instruction": "Remove the blower door.", "manual_pages": [72]},
        ],
        "safety_notes": [],
    }
    result = _diy(monkeypatch, manual_bytes, identity, summary, diy_safety, payload)
    assert len(result.steps) == 2
    assert result.steps[0].manual_pages == [4]


def test_diy_steps_keep_figures_tools_and_citations(
    monkeypatch, manual_bytes, identity, summary, diy_safety
):
    result = _diy(monkeypatch, manual_bytes, identity, summary, diy_safety, STUB_DIY_NO_POWER_STEP)
    trap = result.steps[2]
    assert trap.figure_ref == "Fig. 68"
    assert trap.manual_pages == [65]
    assert trap.caution
    assert result.steps[1].tools == ["nut driver"]
    assert all(s.illustration_key is None for s in result.steps)


# ---------------------------------------------------------------------------
# Live: two model calls, opt-in
# ---------------------------------------------------------------------------


@pytest.mark.skipif(not LIVE, reason="set OPERA_LIVE=1 to spend a real model call")
def test_live_parts_for_the_real_furnace_case(manual_bytes, identity, summary, manual_text):
    result, usage = asyncio.run(parts.run(manual_bytes, identity, summary))
    assert result.parts, "the parts stage returned nothing for a diagnosed case"
    assert usage.get("model")
    for part in result.parts:
        assert is_http_url(part.search_url)
        if part.part_number:
            norm = re.sub(r"[^A-Z0-9]", "", part.part_number.upper())
            assert norm in manual_text, f"{part.name}: {part.part_number!r} not in the manual"
    assert result.numbers_unavailable is True


@pytest.mark.skipif(not LIVE, reason="set OPERA_LIVE=1 to spend a real model call")
def test_live_technician_instructions_for_the_real_furnace_case(
    manual_bytes, identity, summary, tech_safety
):
    result, usage = asyncio.run(instruct.run(manual_bytes, identity, summary, tech_safety))
    assert result.technician_brief and len(result.technician_brief) > 100
    assert [s.instruction for s in result.steps] == HOMEOWNER_SAFE
    assert usage.get("model")
