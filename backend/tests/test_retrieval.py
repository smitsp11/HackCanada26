"""Retrieve stage and diagnose-on-excerpt, with the database, embeddings and
model all stubbed. The live numbers come from `python -m app.eval.bench`."""

from __future__ import annotations

import asyncio
import io

from pypdf import PdfReader, PdfWriter

from app.core import llm as llm_mod
from app.core import pdf
from app.pipeline.stages import diagnose, retrieve
from app.schemas.contracts import ApplianceIdentity, IdentityLevel

IDENT = ApplianceIdentity(brand="Carrier", model_number="59SC6A", appliance_type="gas furnace",
                          confidence=1.0, identity_level=IdentityLevel.EXACT, manual_id="m1")


def blank_pdf(pages: int) -> bytes:
    w = PdfWriter()
    for _ in range(pages):
        w.add_blank_page(width=200, height=200)
    buf = io.BytesIO()
    w.write(buf)
    return buf.getvalue()


def stub_search(monkeypatch, *, code_pages: list[int], hybrid: list[int]) -> list[tuple]:
    calls: list[tuple] = []

    async def fake_fetch(query, *args):
        calls.append((query, args))
        if "unnest(status_codes)" in query:
            return [{"page": p} for p in code_pages]
        return [{"page": p, "score": 1 / (i + 1), "fts_rank": i + 1, "vec_rank": i + 1}
                for i, p in enumerate(hybrid)]

    async def fake_embed(texts, **_):
        return [[0.0] * 1536 for _ in texts], {"model": "stub"}

    monkeypatch.setattr(retrieve.db, "fetch", fake_fetch)
    monkeypatch.setattr(retrieve.embeddings, "embed", fake_embed)
    return calls


def test_extract_code_ignores_flash_counts_and_readings():
    assert retrieve.extract_code("The display shows 33", None) == "33"
    assert retrieve.extract_code("anything", "code 10.1") == "10.1"
    assert retrieve.extract_code("LED flashing 3 times", None) is None
    assert retrieve.extract_code("thermostat set to 68", None) is None


def test_code_pages_rank_first_and_dedupe(monkeypatch):
    stub_search(monkeypatch, code_pages=[71, 54], hybrid=[54, 62, 5])
    r = asyncio.run(retrieve.run("m1", IDENT, "burners shut off", error_code="33", top_k=4))
    assert r.pages == [71, 54, 62, 5]
    assert "status code 33" in r.query


def test_unknown_code_does_not_steer_query(monkeypatch):
    stub_search(monkeypatch, code_pages=[], hybrid=[61])
    r = asyncio.run(retrieve.run("m1", IDENT, "display shows 99", top_k=4))
    assert r.code == "99" and r.code_pages == []
    assert "status code" not in r.query


def test_search_is_scoped_to_manual(monkeypatch):
    calls = stub_search(monkeypatch, code_pages=[], hybrid=[1])
    asyncio.run(retrieve.run("carrier-x", IDENT, "no heat", top_k=4))
    assert all(args[0] == "carrier-x" for _, args in calls)


def test_diagnose_sends_excerpt_and_drops_out_of_set_citations(monkeypatch):
    seen: list[dict] = []

    async def fake_complete(parts, **kwargs):
        seen.append({"parts": parts, **kwargs})
        return {
            "symptom_restated": "s", "abstained": False,
            "causes": [{"summary": "limit", "confidence": 0.8,
                        "manual_pages": [54, 12], "evidence": ["x"]}],
        }, {"model": "stub"}

    monkeypatch.setattr(llm_mod.llm, "complete", fake_complete)
    # The runner cuts the excerpt; diagnose is told which manual pages it holds.
    excerpt = pdf.extract_pages(blank_pdf(74), [54, 61, 71])
    summary, _ = asyncio.run(diagnose.run(excerpt, IDENT, "s", page_numbers=[54, 61, 71]))

    attached = next(p for p in seen[0]["parts"] if p["type"] == "file")
    import base64
    b64 = attached["file"]["file_data"].split(",", 1)[1]
    assert len(PdfReader(io.BytesIO(base64.b64decode(b64))).pages) == 3
    prompt = seen[0]["parts"][-1]["text"]
    assert "54, 61, 71" in prompt
    # Page 12 was never sent, so the model cannot have read it.
    assert summary.causes[0].manual_pages == [54]


def test_diagnose_without_pages_sends_whole_manual(monkeypatch):
    seen: list[dict] = []

    async def fake_complete(parts, **kwargs):
        seen.append(parts)
        return {"symptom_restated": "s", "abstained": True, "causes": []}, {}

    monkeypatch.setattr(llm_mod.llm, "complete", fake_complete)
    asyncio.run(diagnose.run(blank_pdf(5), IDENT, "s"))
    attached = next(p for p in seen[0] if p["type"] == "file")
    assert attached["file"]["filename"] == "manual.pdf"
