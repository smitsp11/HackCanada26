from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from .models import ParsedBlock


_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$")
_WARNING_RE = re.compile(r"^\s*(WARNING|CAUTION)\b[:\-\s]*(.+)?$", re.IGNORECASE)
_NOTE_RE = re.compile(r"^\s*(NOTE|NOTES)\b[:\-\s]*(.+)?$", re.IGNORECASE)
_TABLE_ROW_RE = re.compile(r"^\s*\|.*\|\s*$")
_LIST_RE = re.compile(r"^\s*([-*])\s+.+$")
_NUM_STEP_RE = re.compile(r"^\s*(\d+)[\).\]]\s+.+$")
_CAPTION_RE = re.compile(r"^\s*(Figure|Fig\.|Image|Photo)\s*\d*[:\.\-\s]+.+$", re.IGNORECASE)


def _normalize_newlines(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n")


def _split_preserving_tables(lines: list[str]) -> list[list[str]]:
    """
    Split into paragraphs/blocks, but keep contiguous markdown table rows together.
    """
    blocks: list[list[str]] = []
    buf: list[str] = []
    in_table = False

    def flush() -> None:
        nonlocal buf, in_table
        if buf:
            blocks.append(buf)
        buf = []
        in_table = False

    for ln in lines:
        is_blank = ln.strip() == ""
        is_table = bool(_TABLE_ROW_RE.match(ln))

        if is_blank:
            flush()
            continue

        if is_table:
            in_table = True
            buf.append(ln)
            continue

        if in_table and not is_table:
            flush()
            buf.append(ln)
            continue

        buf.append(ln)

    flush()
    return blocks


def _classify_block(text: str) -> str:
    first = text.splitlines()[0].strip() if text.strip() else ""
    if _HEADING_RE.match(first):
        return "heading"
    if _TABLE_ROW_RE.match(first):
        return "table"
    if _WARNING_RE.match(first):
        return "warning"
    if _NOTE_RE.match(first):
        return "note"
    if _CAPTION_RE.match(first):
        return "caption"
    if any(_NUM_STEP_RE.match(ln) for ln in text.splitlines()):
        return "procedure"
    if all(_LIST_RE.match(ln) for ln in text.splitlines() if ln.strip()):
        return "list"
    return "paragraph"


@dataclass(frozen=True, slots=True)
class LlamaParseAdapter:
    """
    Adapter around `llama_parse` that yields structured ParsedBlock objects.
    """

    api_key: str

    def parse_pdf(self, pdf_path: str) -> list[ParsedBlock]:
        path = Path(pdf_path)
        if not path.exists() or not path.is_file():
            raise FileNotFoundError(f"PDF not found: {pdf_path}")

        from llama_parse import LlamaParse

        parser = LlamaParse(
            api_key=self.api_key,
            result_type="markdown",
        )

        docs = parser.load_data(str(path))
        return self._docs_to_blocks(docs, source_path=str(path))

    def _docs_to_blocks(self, docs: Iterable[Any], source_path: str) -> list[ParsedBlock]:
        blocks: list[ParsedBlock] = []
        heading_stack: list[tuple[int, str]] = []

        def current_heading_path() -> list[str]:
            return [h for _, h in heading_stack]

        block_counter = 0

        docs_list = list(docs)
        multi_doc = len(docs_list) > 1

        for doc_idx, doc in enumerate(docs_list):
            md = getattr(doc, "text", None) or getattr(doc, "markdown", None) or ""
            md = _normalize_newlines(str(md))

            page_num: int | None = None
            meta: dict[str, Any] = {}
            doc_meta = getattr(doc, "metadata", None)
            if isinstance(doc_meta, dict):
                meta = dict(doc_meta)
                # Attempt common page markers.
                for k in ("page", "page_num", "page_number"):
                    v = doc_meta.get(k)
                    if isinstance(v, int):
                        page_num = v
                        break
                    if isinstance(v, str) and v.strip().isdigit():
                        page_num = int(v.strip())
                        break

            # LlamaParse often returns one document per PDF page without explicit page fields.
            if page_num is None and multi_doc:
                page_num = doc_idx + 1

            lines = md.split("\n")
            for raw_block_lines in _split_preserving_tables(lines):
                text = "\n".join(raw_block_lines).strip("\n")
                if text.strip() == "":
                    continue

                # Update heading stack if this block is a heading.
                m = _HEADING_RE.match(text.splitlines()[0].strip())
                if m:
                    level = len(m.group(1))
                    title = m.group(2).strip()
                    while heading_stack and heading_stack[-1][0] >= level:
                        heading_stack.pop()
                    heading_stack.append((level, title))

                block_type = _classify_block(text)
                block_counter += 1
                block_id = f"block-{doc_idx:04d}-{block_counter:06d}-{uuid.uuid4().hex[:8]}"

                blocks.append(
                    ParsedBlock(
                        block_id=block_id,
                        block_type=block_type,
                        text=text.strip(),
                        heading_path=current_heading_path(),
                        page_num=page_num,
                        metadata={
                            "source_path": source_path,
                            "doc_index": doc_idx,
                            **meta,
                        },
                    )
                )

        return blocks

