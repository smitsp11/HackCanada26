from __future__ import annotations

from dataclasses import dataclass

from .chunker import ManualChunker
from .embedder import Embedder
from .models import Chunk, ParsedBlock
from .parser_llamaparse import LlamaParseAdapter
from .vector_store_faiss import FaissVectorStore


@dataclass(frozen=True, slots=True)
class IngestPipeline:
    """
    Orchestrates manual ingestion:
    parse -> chunk -> embed -> store
    """

    parser: LlamaParseAdapter
    chunker: ManualChunker
    embedder: Embedder
    store: FaissVectorStore

    def run(self, pdf_path: str, document_id: str) -> dict[str, int | str]:
        blocks: list[ParsedBlock] = self.parser.parse_pdf(pdf_path)
        chunks: list[Chunk] = self.chunker.chunk_blocks(blocks, document_id=document_id)

        if not chunks:
            # Ensure store exists even if empty (infer dim from existing index or a probe embedding).
            dim = self._infer_or_load_dim()
            self.store.create_or_load(dim=dim)
            return {"document_id": document_id, "chunk_count": 0, "index_size": self.store.size}

        embeddings = self.embedder.embed_texts([c.text for c in chunks])
        dim = self.embedder.infer_dim(embeddings[0])
        self.store.create_or_load(dim=dim)
        self.store.upsert(chunks, embeddings)

        return {"document_id": document_id, "chunk_count": len(chunks), "index_size": self.store.size}

    def _infer_or_load_dim(self) -> int:
        # Try to load existing FAISS index dim without needing an embedding API call.
        try:
            import faiss  # type: ignore
            from pathlib import Path

            index_path = Path(self.store.dir_path) / "index.faiss"
            if index_path.exists():
                idx = faiss.read_index(str(index_path))
                return int(idx.d)
        except Exception:
            pass

        # Fall back to a small probe embedding to infer dimension.
        probe = self.embedder.embed_text("dimension probe")
        return self.embedder.infer_dim(probe)

