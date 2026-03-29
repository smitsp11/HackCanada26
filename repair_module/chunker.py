from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable

from .models import Chunk, ChunkConfig, ParsedBlock


_TABLE_ROW_RE = re.compile(r"^\s*\|.*\|\s*$")


def _safe_join(parts: Iterable[str]) -> str:
    return "\n\n".join(p for p in parts if p.strip() != "")


def _last_heading(heading_path: list[str]) -> str | None:
    return heading_path[-1] if heading_path else None


def _split_large_table(text: str, max_chars: int) -> list[str]:
    """
    Split a markdown pipe table into smaller tables by rows,
    preserving header + separator lines when possible.
    """
    lines = [ln for ln in text.splitlines() if ln.strip() != ""]
    if not lines or not _TABLE_ROW_RE.match(lines[0]):
        return [text]

    header: list[str] = []
    body: list[str] = []

    if len(lines) >= 2 and _TABLE_ROW_RE.match(lines[0]) and _TABLE_ROW_RE.match(lines[1]):
        header = [lines[0], lines[1]]
        body = lines[2:]
    else:
        body = lines

    chunks: list[list[str]] = []
    cur: list[str] = header.copy() if header else []
    cur_len = sum(len(x) + 1 for x in cur)

    def flush() -> None:
        nonlocal cur, cur_len
        if cur:
            chunks.append(cur)
        cur = header.copy() if header else []
        cur_len = sum(len(x) + 1 for x in cur)

    for row in body:
        row_len = len(row) + 1
        if cur and (cur_len + row_len) > max_chars and len(cur) > len(header):
            flush()
        cur.append(row)
        cur_len += row_len

    flush()
    return ["\n".join(c).strip() for c in chunks if c]


def _split_text_with_overlap(text: str, max_chars: int, overlap_chars: int) -> list[str]:
    if len(text) <= max_chars:
        return [text]
    if max_chars <= 0:
        return [text]

    out: list[str] = []
    start = 0
    while start < len(text):
        end = min(len(text), start + max_chars)
        chunk = text[start:end].strip()
        if chunk:
            out.append(chunk)
        if end >= len(text):
            break
        start = max(0, end - max(0, overlap_chars))
    return out


@dataclass(frozen=True, slots=True)
class ManualChunker:
    """
    Semantically chunk ParsedBlocks into retrieval-ready Chunks.
    """

    config: ChunkConfig

    def chunk_blocks(self, blocks: list[ParsedBlock], document_id: str) -> list[Chunk]:
        if not document_id:
            raise ValueError("document_id must be non-empty")
        if not blocks:
            return []

        # Phase 1: pre-process blocks (table splitting, caption attachment markers)
        expanded: list[ParsedBlock] = []
        for b in blocks:
            if b.block_type == "table" and not self.config.keep_tables_atomic and len(b.text) > self.config.max_chars:
                for i, part in enumerate(_split_large_table(b.text, self.config.max_chars)):
                    expanded.append(
                        ParsedBlock(
                            block_id=f"{b.block_id}-part{i+1}",
                            block_type="table",
                            text=part,
                            heading_path=b.heading_path,
                            page_num=b.page_num,
                            metadata=dict(b.metadata),
                        )
                    )
            elif b.block_type == "table" and self.config.keep_tables_atomic and len(b.text) > self.config.max_chars:
                # Must keep table intact "if possible"; when impossible, split by rows.
                for i, part in enumerate(_split_large_table(b.text, self.config.max_chars)):
                    expanded.append(
                        ParsedBlock(
                            block_id=f"{b.block_id}-part{i+1}",
                            block_type="table",
                            text=part,
                            heading_path=b.heading_path,
                            page_num=b.page_num,
                            metadata=dict(b.metadata),
                        )
                    )
            else:
                expanded.append(b)

        # Phase 2: greedy grouping with semantic rules
        chunks: list[Chunk] = []
        buffer_blocks: list[ParsedBlock] = []

        def buffer_heading_path() -> list[str]:
            if not buffer_blocks:
                return []
            return buffer_blocks[-1].heading_path

        def buffer_pages() -> tuple[int | None, int | None]:
            pages = [b.page_num for b in buffer_blocks if b.page_num is not None]
            if not pages:
                return None, None
            return min(pages), max(pages)

        def flush(chunk_type: str = "content") -> None:
            nonlocal buffer_blocks
            if not buffer_blocks:
                return

            heading_path = buffer_heading_path()
            page_start, page_end = buffer_pages()
            texts: list[str] = []
            source_types: set[str] = set()
            for b in buffer_blocks:
                source_types.add(b.block_type)
                texts.append(b.text.strip())

            prefix = ""
            if self.config.include_heading_prefix and heading_path:
                prefix = " > ".join(heading_path).strip() + "\n\n"

            body = _safe_join(texts)
            full_text = (prefix + body).strip()

            # If too large, split into subchunks while keeping metadata coherent.
            for part_idx, part_text in enumerate(
                _split_text_with_overlap(full_text, self.config.max_chars, self.config.overlap_chars)
            ):
                chunk_id = f"{document_id}-chunk-{len(chunks)+1:04d}"
                chunk_meta = {
                    "document_id": document_id,
                    "section_title": _last_heading(heading_path),
                    "chunk_size_chars": len(part_text),
                    "source_block_types": sorted(source_types),
                    "part_index": part_idx,
                }
                chunks.append(
                    Chunk(
                        chunk_id=chunk_id,
                        chunk_type=chunk_type,
                        text=part_text,
                        heading_path=list(heading_path),
                        page_start=page_start,
                        page_end=page_end,
                        block_ids=[b.block_id for b in buffer_blocks],
                        metadata=chunk_meta,
                    )
                )

            buffer_blocks = []

        def should_break(prev: ParsedBlock | None, cur: ParsedBlock) -> bool:
            if prev is None:
                return False

            # Respect heading boundary changes.
            if prev.heading_path != cur.heading_path:
                # Captions can be attached to adjacent text if enabled.
                if self.config.attach_captions_to_adjacent_text and prev.block_type == "caption":
                    return False
                if self.config.attach_captions_to_adjacent_text and cur.block_type == "caption":
                    return False
                return True

            # Warnings atomic: isolate from other text unless tiny (still its own chunk if keep_warnings_atomic).
            if self.config.keep_warnings_atomic:
                if prev.block_type == "warning" or cur.block_type == "warning":
                    return True

            # Tables: keep separated unless small enough and paragraph adjacency makes sense.
            if self.config.keep_tables_atomic:
                if prev.block_type == "table" or cur.block_type == "table":
                    return True

            # Keep procedure steps grouped; don't mix with unrelated paragraphs if buffer is near target.
            if prev.block_type == "procedure" and cur.block_type == "procedure":
                return False
            if prev.block_type == "procedure" and cur.block_type not in ("procedure", "warning", "note", "caption"):
                return True
            if cur.block_type == "procedure" and prev.block_type not in ("procedure", "warning", "note", "caption"):
                return True

            return False

        for idx, b in enumerate(expanded):
            prev = expanded[idx - 1] if idx > 0 else None

            # Force atomic blocks into their own chunk when configured.
            if b.block_type == "warning" and self.config.keep_warnings_atomic:
                flush()
                buffer_blocks = [b]
                flush(chunk_type="warning")
                continue

            if b.block_type == "table" and self.config.keep_tables_atomic:
                flush()
                buffer_blocks = [b]
                flush(chunk_type="table")
                continue

            if should_break(prev, b):
                flush()

            buffer_blocks.append(b)

            # Size-based flush.
            cur_text = _safe_join([x.text for x in buffer_blocks])
            prefix_len = len(" > ".join(buffer_blocks[-1].heading_path)) + 4 if (
                self.config.include_heading_prefix and buffer_blocks[-1].heading_path
            ) else 0
            if len(cur_text) + prefix_len >= self.config.target_chars:
                flush()

        flush()

        # Phase 3: merge small chunks when safe
        if not chunks:
            return []

        merged: list[Chunk] = []
        i = 0
        while i < len(chunks):
            c = chunks[i]
            if c.metadata.get("chunk_size_chars", len(c.text)) >= self.config.soft_min_chars or i == len(chunks) - 1:
                merged.append(c)
                i += 1
                continue

            nxt = chunks[i + 1]
            # Only merge if same section and both are "content".
            if (
                c.chunk_type == "content"
                and nxt.chunk_type == "content"
                and c.heading_path == nxt.heading_path
                and (len(c.text) + 2 + len(nxt.text)) <= self.config.max_chars
            ):
                joined_text = (c.text.strip() + "\n\n" + nxt.text.strip()).strip()
                new_meta = dict(c.metadata)
                new_meta["chunk_size_chars"] = len(joined_text)
                new_meta["source_block_types"] = sorted(
                    set(c.metadata.get("source_block_types", [])) | set(nxt.metadata.get("source_block_types", []))
                )
                merged.append(
                    Chunk(
                        chunk_id=c.chunk_id,  # keep deterministic id of the first
                        chunk_type="content",
                        text=joined_text,
                        heading_path=c.heading_path,
                        page_start=c.page_start if c.page_start is not None else nxt.page_start,
                        page_end=nxt.page_end if nxt.page_end is not None else c.page_end,
                        block_ids=c.block_ids + nxt.block_ids,
                        metadata=new_meta,
                    )
                )
                i += 2
            else:
                merged.append(c)
                i += 1

        # Re-number chunk_ids deterministically after merges.
        renumbered: list[Chunk] = []
        for j, c in enumerate(merged, start=1):
            meta = dict(c.metadata)
            meta["chunk_size_chars"] = len(c.text)
            renumbered.append(
                Chunk(
                    chunk_id=f"{document_id}-chunk-{j:04d}",
                    chunk_type=c.chunk_type,
                    text=c.text,
                    heading_path=c.heading_path,
                    page_start=c.page_start,
                    page_end=c.page_end,
                    block_ids=c.block_ids,
                    metadata=meta,
                )
            )

        return renumbered

