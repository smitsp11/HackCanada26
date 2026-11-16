"""Assertions over recorded pipeline output.

    ./.venv/bin/python -m pytest tests/test_phase_a.py -v

Fast and free: reads tests/golden/*.json rather than re-running the pipeline.
Regenerate the goldens with `python -m tests.record` after changing a prompt,
a schema or a model - a diff in these tests then tells you what your change
actually did.

Two layers of assertion:

  invariants   must hold for any case, forever. Cited pages exist. Causes are
               ranked. Quotes are not fabricated. Results persist.
  expectations per-case, declared in cases.json. These encode product judgment
               (a gas furnace routes to a technician; code 34.1 should put gas
               delivery above igniter failure) and are allowed to change when
               the judgment changes.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.pipeline import verify
from app.schemas.contracts import Cause, RepairSummary

HERE = Path(__file__).parent
GOLDEN = HERE / "golden"
MANUAL = Path("manuals/opera-manual.pdf")

CASES = json.loads((HERE / "cases.json").read_text())


def _load(case_id: str):
    path = GOLDEN / f"{case_id}.json"
    if not path.exists():
        pytest.skip(f"no recording for {case_id} - run: python -m tests.record {case_id}")
    return json.loads(path.read_text())


def _summary(result: dict) -> RepairSummary:
    s = result["summary"]
    return RepairSummary(
        symptom_restated=s["symptom_restated"],
        causes=[Cause(**c) for c in s["causes"]],
        abstained=s["abstained"],
        grounded=s["grounded"],
    )


def _ids():
    return [c["id"] for c in CASES]


def _case(case_id: str) -> dict:
    return next(c for c in CASES if c["id"] == case_id)


# ---------------------------------------------------------------------------
# Invariants - true for every case
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("case_id", _ids())
def test_causes_ranked_by_confidence(case_id):
    causes = _load(case_id)["summary"]["causes"]
    confs = [c["confidence"] for c in causes]
    assert confs == sorted(confs, reverse=True), f"causes not ranked: {confs}"


@pytest.mark.parametrize("case_id", _ids())
def test_confidences_in_unit_range(case_id):
    for c in _load(case_id)["summary"]["causes"]:
        assert 0.0 <= c["confidence"] <= 1.0, f"{c['summary']!r} -> {c['confidence']}"


@pytest.mark.parametrize("case_id", _ids())
def test_cited_pages_exist_in_the_manual(case_id):
    result = _load(case_id)
    if not result["summary"]["grounded"]:
        pytest.skip("ungrounded answer cites no pages")
    report = verify.verify(_summary(result), MANUAL.read_bytes())
    bad = [c for c in report.causes if c.out_of_range]
    assert not bad, f"pages outside 1-{report.page_count}: {[c.out_of_range for c in bad]}"


@pytest.mark.parametrize("case_id", _ids())
def test_quotes_are_not_fabricated(case_id):
    """Every quote either verifies on a cited page, or the page is a diagram.

    NOT_FOUND means the page has plenty of text and the quote isn't in it,
    which is the fabrication signature this whole suite exists to catch.
    """
    result = _load(case_id)
    if not result["summary"]["grounded"]:
        pytest.skip("ungrounded answer quotes nothing")
    report = verify.verify(_summary(result), MANUAL.read_bytes())
    assert report.ok, "\n".join(report.failures())


@pytest.mark.parametrize("case_id", _ids())
def test_grounded_answers_cite_something(case_id):
    result = _load(case_id)
    if not result["summary"]["grounded"]:
        pytest.skip("not grounded")
    assert any(
        c["manual_pages"] for c in result["summary"]["causes"]
    ), "claims to be grounded but no cause cites a page"


@pytest.mark.parametrize("case_id", _ids())
def test_safety_verdict_is_always_set(case_id):
    safety = _load(case_id)["summary"].get("safety")
    assert safety, "no safety assessment - the gate must always run"
    assert safety["verdict"] in ("diy", "technician")


@pytest.mark.parametrize("case_id", _ids())
def test_result_persisted_independently_of_the_request(case_id):
    """The old backend lost results when the connection dropped. Never again."""
    p = _load(case_id)["_persisted"]
    assert p["status"] == "ready"
    assert "identify" in p["stages"] and "diagnose" in p["stages"]
    assert p["cause_count"] == len(_load(case_id)["summary"]["causes"])


# ---------------------------------------------------------------------------
# Expectations - per-case product judgment, declared in cases.json
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("case_id", _ids())
def test_identity(case_id):
    result, exp = _load(case_id), _case(case_id)["expect"]
    identity = result["identity"]

    for field in ("brand", "unit_number", "manual_id", "identity_level"):
        if field in exp:
            got = identity.get(field) if field != "manual_id" else identity.get("manual_id")
            assert got == exp[field], f"{field}: expected {exp[field]!r}, got {got!r}"

    if "identity_level_in" in exp:
        assert identity["identity_level"] in exp["identity_level_in"]

    if "min_identity_confidence" in exp:
        assert identity["confidence"] >= exp["min_identity_confidence"]


@pytest.mark.parametrize("case_id", _ids())
def test_safety_expectation(case_id):
    result, exp = _load(case_id), _case(case_id)["expect"]
    safety = result["summary"]["safety"]

    if "safety_verdict" in exp:
        assert safety["verdict"] == exp["safety_verdict"]
    for hazard in exp.get("hazards_include", []):
        assert hazard in safety["hazards"], f"missing hazard {hazard}: {safety['hazards']}"


@pytest.mark.parametrize("case_id", _ids())
def test_diagnosis_expectation(case_id):
    result, exp = _load(case_id), _case(case_id)["expect"]
    summary = result["summary"]

    if "grounded" in exp:
        assert summary["grounded"] is exp["grounded"]
    if "abstained" in exp:
        assert summary["abstained"] is exp["abstained"]
    if "min_causes" in exp:
        assert len(summary["causes"]) >= exp["min_causes"]

    if "top_cause_mentions_any" in exp:
        top = summary["causes"][0]
        blob = " ".join(
            [top["summary"], top.get("detail") or "", " ".join(top.get("components") or [])]
        ).lower()
        assert any(k in blob for k in exp["top_cause_mentions_any"]), (
            f"top cause {top['summary']!r} mentions none of {exp['top_cause_mentions_any']}"
        )

    if "cites_code" in exp:
        codes = {c for cause in summary["causes"] for c in (cause.get("error_codes") or [])}
        assert exp["cites_code"] in codes, f"expected code {exp['cites_code']}, saw {codes}"

    if exp.get("asks_clarifying_question"):
        assert summary["clarifying_questions"], "expected at least one clarifying question"


# ---------------------------------------------------------------------------
# Safety gate is pure logic - no recording needed
# ---------------------------------------------------------------------------


def test_safety_gate_rules():
    from app.pipeline.safety import assess, parse_hazards

    assert assess(parse_hazards(["gas"])).verdict.value == "technician"
    assert assess(parse_hazards(["sealed_refrigerant"])).verdict.value == "technician"
    assert assess(parse_hazards(["high_voltage"])).verdict.value == "diy"
    assert assess([], identified=False).verdict.value == "technician"
    assert assess(parse_hazards(["bogus_class"])).verdict.value == "diy"
