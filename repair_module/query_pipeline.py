from __future__ import annotations

import re
from dataclasses import dataclass

from .embedder import Embedder
from .models import QueryResponse
from .vector_store_faiss import FaissVectorStore


_WS_RE = re.compile(r"\s+")


def _normalize_query(q: str) -> str:
    q = q.strip()
    q = _WS_RE.sub(" ", q)
    return q


@dataclass(frozen=True, slots=True)
class QueryPipeline:
    """
    Orchestrates query:
    normalize -> embed -> search -> response
    """

    embedder: Embedder
    store: FaissVectorStore

    def run(self, query: str, top_k: int) -> QueryResponse:
        normalized = _normalize_query(query)
        if normalized == "":
            raise ValueError("query must be non-empty")

        # No index yet or empty index: return empty results (avoid RuntimeError and spare an embed call).
        if not self.store.is_ready or self.store.size == 0:
            return QueryResponse(query=normalized, results=[])

        emb = self.embedder.embed_text(normalized)
        results = self.store.search(emb, top_k=top_k)
        return QueryResponse(query=normalized, results=results)

