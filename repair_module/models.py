from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal


@dataclass(frozen=True, slots=True)
class ParsedBlock:
    """
    Atomic block derived from parsed manual output.

    `heading_path` is the hierarchy of headings (e.g. ["Installation", "Igniter"]).
    """

    block_id: str
    block_type: str
    text: str
    heading_path: list[str]
    page_num: int | None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class Chunk:
    """
    Retrieval unit created from one or more ParsedBlock items.
    """

    chunk_id: str
    chunk_type: str
    text: str
    heading_path: list[str]
    page_start: int | None
    page_end: int | None
    block_ids: list[str]
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class ChunkConfig:
    """
    Chunking behavior configuration.
    """

    target_chars: int = 1200
    max_chars: int = 1800
    soft_min_chars: int = 600
    overlap_chars: int = 160
    keep_tables_atomic: bool = True
    keep_warnings_atomic: bool = True
    attach_captions_to_adjacent_text: bool = True
    include_heading_prefix: bool = True


@dataclass(frozen=True, slots=True)
class SearchResult:
    chunk_id: str
    score: float
    text: str
    metadata: dict[str, Any]


@dataclass(frozen=True, slots=True)
class QueryResponse:
    query: str
    results: list[SearchResult]


BlockType = Literal[
    "heading",
    "paragraph",
    "table",
    "warning",
    "note",
    "procedure",
    "caption",
    "list",
]

