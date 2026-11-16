"""Page-level retrieval index. Offline, once per manual; users never wait on it.

    python -m app.ingestion.cli index manuals/opera-manual.pdf

For every page:
  1. pypdf text, running header stripped (it repeats on all 74 pages and would
     otherwise dominate both BM25-style and vector similarity).
  2. One cheap vision call on the rendered page: a one-line summary, a
     description of any flowchart/diagram/table that only exists as pixels, and
     the status codes and components the page covers. On the Carrier manual,
     pages 70-73 (the troubleshooting guide) have ~230 characters of text each;
     without this step they are effectively unsearchable, and they are the
     pages that matter most.
  3. An embedding of summary + description + codes + text.

Idempotent: re-running upserts every page.
"""

from __future__ import annotations

import asyncio
import io
import re
import time
from typing import Any

from pypdf import PdfReader, PdfWriter

from app.config import settings
from app.core import db, embeddings, llm

# Below this much extractable text a page is treated as a diagram. Same
# threshold verify.py uses to call a page UNVERIFIABLE.
IMAGE_HEAVY_MAX_CHARS = 700
CONCURRENCY = 8
EMBED_BATCH = 32

# The running header/footer printed on every page of Carrier manuals.
_BOILERPLATE = re.compile(
    r"^(59SC6A: Installation, Start-up, Operating and Service and Maintenance Instructions"
    r"|Manufacturer reserves the right to change.*)$",
    re.MULTILINE,
)

PAGE_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {
            "type": "string",
            "description": "One or two sentences: what a technician would come to this page for.",
        },
        "visual_description": {
            "type": "string",
            "description": (
                "Describe any flowchart, diagram, wiring schematic or table on this page in "
                "under 150 words: what it shows, the decision steps or fault paths, the kind "
                "of values a table holds. This is for search, so name things; do not "
                "transcribe every cell. Empty string if the page is plain prose."
            ),
        },
        "status_codes": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Status/fault codes this page explains, as printed (e.g. '33', '13', '31.1').",
        },
        "components": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Furnace components this page is about, lower case (e.g. 'pressure switch').",
        },
    },
    "required": ["summary", "visual_description", "status_codes", "components"],
    "additionalProperties": False,
}

PAGE_PROMPT = (
    "This is page {page} of a {brand} appliance service manual. Index it for a "
    "retrieval system that will match homeowner and technician symptom descriptions "
    "to manual pages. Be specific and literal; do not add anything not on the page."
)


def clean_text(raw: str) -> str:
    text = _BOILERPLATE.sub("", raw or "")
    return re.sub(r"[ \t]+", " ", text).strip()


def _single_pages(data: bytes) -> list[tuple[str, bytes]]:
    """(text, single-page PDF) per page, parsing the source once."""
    reader = PdfReader(io.BytesIO(data))
    out = []
    for page in reader.pages:
        writer = PdfWriter()
        writer.add_page(page)
        buf = io.BytesIO()
        writer.write(buf)
        out.append((clean_text(page.extract_text() or ""), buf.getvalue()))
    return out


def embedding_input(row: dict[str, Any]) -> str:
    parts = [row["summary"]]
    if row["visual_description"]:
        parts.append(row["visual_description"])
    if row["status_codes"]:
        parts.append("Status codes: " + ", ".join(row["status_codes"]))
    if row["components"]:
        parts.append("Components: " + ", ".join(row["components"]))
    parts.append(row["text"])
    return "\n".join(p for p in parts if p)


def normalize_code(code: str) -> str:
    return re.sub(r"[^0-9.]", "", code or "").strip(".")


async def index_manual(manual_id: str, data: bytes, brand: str) -> dict[str, Any]:
    t0 = time.perf_counter()
    pages = await asyncio.to_thread(_single_pages, data)
    print(f"  {len(pages)} pages split in {time.perf_counter() - t0:.1f}s")

    sem = asyncio.Semaphore(CONCURRENCY)
    cost = 0.0

    async def enrich(n: int, text: str, page_pdf: bytes) -> dict[str, Any]:
        nonlocal cost
        out: dict[str, Any] = {}
        async with sem:
            for attempt in range(2):
                try:
                    out, usage = await llm.llm.complete(
                        [llm.pdf_part(page_pdf, f"page-{n}.pdf"),
                         llm.text_part(PAGE_PROMPT.format(page=n, brand=brand))],
                        model=settings.model_default,
                        schema=PAGE_SCHEMA,
                        schema_name="manual_page",
                        max_tokens=6000,
                    )
                    cost += usage.get("cost") or 0.0
                    break
                except llm.LLMError as e:
                    # One unreadable page must not sink the manual: it stays
                    # searchable by its text, just without enrichment.
                    print(f"  page {n}: enrichment attempt {attempt + 1} failed: {str(e)[:120]}")
        return {
            "page": n,
            "text": text,
            "summary": out.get("summary") or "",
            "visual_description": out.get("visual_description") or "",
            "status_codes": sorted({c for c in map(normalize_code, out.get("status_codes") or []) if c}),
            "components": sorted({c.strip().lower() for c in out.get("components") or [] if c.strip()}),
            "image_heavy": len(text) < IMAGE_HEAVY_MAX_CHARS,
        }

    t1 = time.perf_counter()
    rows = await asyncio.gather(*(enrich(n, t, p) for n, (t, p) in enumerate(pages, 1)))
    print(f"  enriched {len(rows)} pages in {time.perf_counter() - t1:.1f}s")

    t2 = time.perf_counter()
    for i in range(0, len(rows), EMBED_BATCH):
        batch = rows[i : i + EMBED_BATCH]
        vecs, usage = await embeddings.embed([embedding_input(r) for r in batch])
        cost += usage.get("cost") or 0.0
        for r, v in zip(batch, vecs):
            r["embedding"] = embeddings.to_pgvector(v)
    print(f"  embedded in {time.perf_counter() - t2:.1f}s")

    for r in rows:
        await db.execute(
            """INSERT INTO manual_pages (manual_id, page, text, summary, visual_description,
                                         status_codes, components, image_heavy, embedding,
                                         embedding_model)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::vector,$10)
               ON CONFLICT (manual_id, page) DO UPDATE SET
                 text=EXCLUDED.text, summary=EXCLUDED.summary,
                 visual_description=EXCLUDED.visual_description,
                 status_codes=EXCLUDED.status_codes, components=EXCLUDED.components,
                 image_heavy=EXCLUDED.image_heavy, embedding=EXCLUDED.embedding,
                 embedding_model=EXCLUDED.embedding_model""",
            manual_id, r["page"], r["text"], r["summary"], r["visual_description"],
            r["status_codes"], r["components"], r["image_heavy"], r["embedding"],
            settings.model_embedding,
        )

    return {
        "pages": len(rows),
        "image_heavy": [r["page"] for r in rows if r["image_heavy"]],
        "pages_with_codes": {r["page"]: r["status_codes"] for r in rows if r["status_codes"]},
        "seconds": round(time.perf_counter() - t0, 1),
        "cost": round(cost, 4),
    }
