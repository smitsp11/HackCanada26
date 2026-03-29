from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .models import Chunk, SearchResult


def _ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def _atomic_write_json(path: Path, data: Any) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


@dataclass
class FaissVectorStore:
    """
    Simple FAISS-backed vector store with JSON metadata persistence.

    Persistence files (in `dir_path`):
    - `index.faiss`
    - `metadata.json` (list aligned with FAISS vector ids)
    """

    dir_path: str

    def __post_init__(self) -> None:
        if not self.dir_path:
            raise ValueError("dir_path must be non-empty")
        self._dir = Path(self.dir_path)
        _ensure_dir(self._dir)
        self._index_path = self._dir / "index.faiss"
        self._meta_path = self._dir / "metadata.json"
        self._index: Any | None = None  # faiss.Index, imported lazily
        self._records: list[dict[str, Any]] = []
        self._id_to_pos: dict[str, int] = {}

    def create_or_load(self, dim: int) -> None:
        import faiss  # type: ignore

        if dim <= 0:
            raise ValueError("dim must be > 0")

        if self._index_path.exists() and self._meta_path.exists():
            index = faiss.read_index(str(self._index_path))
            records = json.loads(self._meta_path.read_text(encoding="utf-8"))
            if not isinstance(records, list):
                raise ValueError("metadata.json must be a list")
            if index.d != dim:
                raise ValueError(f"FAISS index dim mismatch: expected {dim}, got {index.d}")
            if index.ntotal != len(records):
                raise ValueError(
                    f"FAISS index / metadata mismatch: index.ntotal={index.ntotal}, records={len(records)}"
                )
            self._index = index
            self._records = records
            self._id_to_pos = {r["chunk_id"]: i for i, r in enumerate(records) if isinstance(r, dict) and "chunk_id" in r}
            return

        self._index = faiss.IndexFlatL2(dim)
        self._records = []
        self._id_to_pos = {}
        self._persist()

    @property
    def is_ready(self) -> bool:
        """True after `create_or_load` has been called successfully."""
        return self._index is not None

    @property
    def dim(self) -> int:
        if self._index is None:
            raise RuntimeError("Vector store not initialized. Call create_or_load(dim) first.")
        return int(self._index.d)

    @property
    def size(self) -> int:
        if self._index is None:
            return 0
        return int(self._index.ntotal)

    def upsert(self, chunks: list[Chunk], embeddings: list[list[float]]) -> None:
        import numpy as np

        if self._index is None:
            raise RuntimeError("Vector store not initialized. Call create_or_load(dim) first.")
        if len(chunks) != len(embeddings):
            raise ValueError("chunks and embeddings length mismatch")
        if not chunks:
            return

        # IndexFlatL2 has no native delete/update; enforce append-only for determinism and safety.
        for c in chunks:
            if c.chunk_id in self._id_to_pos:
                raise ValueError(
                    f"Chunk already exists in index (append-only store). chunk_id={c.chunk_id}"
                )

        mat = np.asarray(embeddings, dtype=np.float32)
        if mat.ndim != 2:
            raise ValueError("embeddings must be a 2D array-like")
        if mat.shape[1] != self._index.d:
            raise ValueError(f"Embedding dim mismatch: expected {self._index.d}, got {mat.shape[1]}")

        self._index.add(mat)

        start_pos = len(self._records)
        for i, c in enumerate(chunks):
            rec = {
                "chunk_id": c.chunk_id,
                "text": c.text,
                "metadata": c.metadata,
            }
            self._records.append(rec)
            self._id_to_pos[c.chunk_id] = start_pos + i

        self._persist()

    def search(self, query_embedding: list[float], top_k: int) -> list[SearchResult]:
        import numpy as np

        if self._index is None:
            raise RuntimeError("Vector store not initialized. Call create_or_load(dim) first.")
        if top_k <= 0:
            return []
        if self._index.ntotal == 0:
            return []

        q = np.asarray([query_embedding], dtype=np.float32)
        if q.ndim != 2 or q.shape[1] != self._index.d:
            raise ValueError(f"Query embedding dim mismatch: expected {self._index.d}, got {q.shape[1] if q.ndim == 2 else 'invalid'}")

        k = min(top_k, int(self._index.ntotal))
        distances, indices = self._index.search(q, k)

        results: list[SearchResult] = []
        for dist, idx in zip(distances[0].tolist(), indices[0].tolist(), strict=True):
            if idx < 0 or idx >= len(self._records):
                continue
            rec = self._records[idx]
            results.append(
                SearchResult(
                    chunk_id=str(rec["chunk_id"]),
                    score=float(dist),  # L2 distance; lower is better
                    text=str(rec["text"]),
                    metadata=dict(rec.get("metadata") or {}),
                )
            )
        return results

    def _persist(self) -> None:
        import faiss  # type: ignore

        if self._index is None:
            return
        _ensure_dir(self._dir)
        faiss.write_index(self._index, str(self._index_path))
        _atomic_write_json(self._meta_path, self._records)

