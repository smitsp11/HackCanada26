"""Manual bytes and per-page text, cached.

Both are read by every stage of every case and neither changes after ingestion:

  - bytes: otherwise a 16.5 MB S3 download per stage per case
  - text:  otherwise 24s of pypdf extraction - pure-Python CPU work that holds
           the GIL. Run on the request path it froze the whole server, every
           open event stream included, not just the case that needed it.

Page text is stored as a JSON object in S3 next to the manual rather than in
Postgres. The `manual_pages` table in the shared database belongs to the
retrieval branch and holds text from a different extractor (it strips running
headers and reorders content); the citation verifier and parts stage were built
and tested against pypdf's output, so they keep reading exactly that.
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
from collections import OrderedDict
from typing import Any, Optional

from pypdf import PdfReader

from app.core import db, storage

TEXT_EXTRACTOR = "pypdf"
_BYTES: "OrderedDict[str, bytes]" = OrderedDict()
_TEXT: "OrderedDict[str, list[str]]" = OrderedDict()
_MAX_MANUALS = 4


def _remember(cache: OrderedDict, key: str, value: Any) -> Any:
    cache[key] = value
    cache.move_to_end(key)
    while len(cache) > _MAX_MANUALS:
        cache.popitem(last=False)
    return value


def text_key(manual_id: str) -> str:
    return f"manuals/{manual_id}.{TEXT_EXTRACTOR}-text.json"


async def pdf_bytes(manual_id: str, pdf_path: Optional[str] = None) -> bytes:
    if manual_id in _BYTES:
        _BYTES.move_to_end(manual_id)
        return _BYTES[manual_id]
    if pdf_path is None:
        pdf_path = await db.fetchval("SELECT pdf_path FROM manuals WHERE manual_id=$1", manual_id)
    return _remember(_BYTES, manual_id, await storage.download(pdf_path))


def extract_texts(data: bytes) -> list[str]:
    """Slow: ~24s for 74 pages. Call from a thread, never on the event loop."""
    out = []
    for page in PdfReader(io.BytesIO(data)).pages:
        try:
            out.append(page.extract_text() or "")
        except Exception:
            out.append("")
    return out


async def page_texts(data: bytes) -> list[str]:
    """Per-page pypdf text for a manual: memory, then S3, then extract once.

    Keyed by content hash, so callers holding only bytes needn't know which
    manual they came from. The stored copy carries its sha256 and is ignored if
    it doesn't match - a re-ingested PDF under the same id must not be verified
    against the old document's text.
    """
    sha = hashlib.sha256(data).hexdigest()
    if sha in _TEXT:
        _TEXT.move_to_end(sha)
        return _TEXT[sha]

    # Stored text is a cache, never a dependency: with no database or bucket to
    # hand, extract and carry on rather than fail a stage that works without it.
    manual_id: Optional[str] = None
    try:
        manual_id = await db.fetchval("SELECT manual_id FROM manuals WHERE pdf_sha256=$1", sha)
        if manual_id:
            stored = json.loads(await storage.download(text_key(manual_id)))
            if stored.get("sha256") == sha and stored.get("extractor") == TEXT_EXTRACTOR:
                return _remember(_TEXT, sha, stored["pages"])
    except Exception:
        pass

    texts = await asyncio.to_thread(extract_texts, data)
    if manual_id:
        try:
            await storage.upload(
                text_key(manual_id),
                json.dumps({"sha256": sha, "extractor": TEXT_EXTRACTOR, "pages": texts}).encode(),
                "application/json",
            )
        except Exception:
            pass
    return _remember(_TEXT, sha, texts)


def clear_caches() -> None:
    _BYTES.clear()
    _TEXT.clear()
