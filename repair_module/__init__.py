"""
repair_module

Modular repair manual ingestion + retrieval:
- Parse PDF with LlamaParse
- Convert to structured blocks
- Semantically chunk
- Embed with OpenAI embeddings API
- Store/search with FAISS

Primary entrypoint: `RepairService`
"""

from .config import Settings, load_dotenv_if_present
from .models import (
    Chunk,
    ChunkConfig,
    ParsedBlock,
    SearchResult,
)
from .service import RepairService

__all__ = [
    "load_dotenv_if_present",
    "Settings",
    "ParsedBlock",
    "Chunk",
    "ChunkConfig",
    "SearchResult",
    "RepairService",
]

