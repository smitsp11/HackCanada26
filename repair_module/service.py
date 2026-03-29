from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .chunker import ManualChunker
from .config import Settings
from .embedder import Embedder, GeminiEmbedder, OpenAIEmbedder
from .ingest_pipeline import IngestPipeline
from .models import QueryResponse, SearchResult
from .parser_llamaparse import LlamaParseAdapter
from .query_pipeline import QueryPipeline
from .vector_store_faiss import FaissVectorStore


@dataclass
class RepairService:
    """
    Central service interface for manual ingestion and fix retrieval.

    Public methods:
    - ingest_manual(pdf_path, document_id)
    - query_fix(query, top_k)

    Note:
        The FAISS store is append-only. Re-ingesting the same ``document_id`` will
        reuse the same chunk IDs and ``FaissVectorStore.upsert`` will raise; use a
        new ``document_id``, or delete ``FAISS_DIR`` / replace the index files.
    """

    settings: Settings

    def __post_init__(self) -> None:
        self.parser = LlamaParseAdapter(api_key=self.settings.llama_cloud_api_key)
        self.chunker = ManualChunker(config=self.settings.chunk_config)
        self.embedder = self._build_embedder()
        self.store = FaissVectorStore(dir_path=self.settings.faiss_dir)

        self.ingest_pipeline = IngestPipeline(
            parser=self.parser,
            chunker=self.chunker,
            embedder=self.embedder,
            store=self.store,
        )
        self.query_pipeline = QueryPipeline(embedder=self.embedder, store=self.store)

        # Initialize store if an index already exists (no API call).
        self._init_store_if_present()

    @classmethod
    def from_env(cls) -> "RepairService":
        return cls(settings=Settings.from_env())

    def ingest_manual(self, pdf_path: str, document_id: str) -> dict[str, int | str]:
        return self.ingest_pipeline.run(pdf_path=pdf_path, document_id=document_id)

    def query_fix(self, query: str, top_k: int = 5) -> dict[str, Any]:
        # Ensure store is ready (if index exists it was loaded; otherwise search will be empty).
        if self._store_initialized() is False:
            self._init_store_if_present()

        resp: QueryResponse = self.query_pipeline.run(query=query, top_k=top_k)
        return {
            "query": resp.query,
            "results": [self._result_to_json(r) for r in resp.results],
        }

    def _result_to_json(self, r: SearchResult) -> dict[str, Any]:
        return {
            "chunk_id": r.chunk_id,
            "score": float(r.score),
            "text": r.text,
            "metadata": r.metadata,
        }

    def _store_initialized(self) -> bool:
        try:
            _ = self.store.dim
            return True
        except Exception:
            return False

    def _build_embedder(self) -> Embedder:
        provider = (self.settings.embed_provider or "openai").lower().strip()
        if provider == "gemini":
            if not self.settings.gemini_api_key:
                raise ValueError("GEMINI_API_KEY is required for EMBED_PROVIDER=gemini")
            return GeminiEmbedder(
                api_key=self.settings.gemini_api_key,
                model=self.settings.gemini_embedding_model,
                batch_size=max(1, min(self.settings.embed_batch_size, 100)),
            )
        if provider == "openai":
            if not self.settings.openai_api_key:
                raise ValueError("OPENAI_API_KEY is required for EMBED_PROVIDER=openai")
            return OpenAIEmbedder(
                api_key=self.settings.openai_api_key,
                model=self.settings.embedding_model,
                batch_size=self.settings.embed_batch_size,
            )
        raise ValueError(f"Unsupported EMBED_PROVIDER: {provider!r}")

    def _init_store_if_present(self) -> None:
        # If FAISS index exists, load it using its own dimension.
        try:
            import faiss  # type: ignore
            from pathlib import Path

            index_path = Path(self.store.dir_path) / "index.faiss"
            meta_path = Path(self.store.dir_path) / "metadata.json"
            if index_path.exists() and meta_path.exists():
                idx = faiss.read_index(str(index_path))
                self.store.create_or_load(dim=int(idx.d))
        except Exception:
            # If anything goes wrong, leave store uninitialized; pipelines will init as needed.
            return

