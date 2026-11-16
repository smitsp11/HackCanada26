"""PDF helpers.

Manuals are large (the Carrier 59SC6A is 16.5 MB / 74 pages) and base64 adds
another third on the wire. When a stage only needs a few pages - the safety
scope statement, the nomenclature table - send just those pages instead of the
whole document. Cheaper, faster, and it keeps request bodies well clear of
provider limits.
"""

from __future__ import annotations

import io
from pathlib import Path

from pypdf import PdfReader, PdfWriter


def page_count(data: bytes) -> int:
    return len(PdfReader(io.BytesIO(data)).pages)


def extract_pages(data: bytes, pages: list[int]) -> bytes:
    """Build a new PDF from a 1-indexed page list, preserving order.

    Out-of-range pages are skipped rather than raising, so a caller guessing at
    "the table is probably near the end" degrades instead of crashing.
    """
    reader = PdfReader(io.BytesIO(data))
    writer = PdfWriter()
    total = len(reader.pages)
    for p in pages:
        if 1 <= p <= total:
            writer.add_page(reader.pages[p - 1])
    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue()


def page_window(data: bytes, start: int, end: int) -> bytes:
    """Inclusive 1-indexed range."""
    return extract_pages(data, list(range(start, end + 1)))


def load(path: str | Path) -> bytes:
    return Path(path).read_bytes()
