from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from .models import ChunkConfig


def load_dotenv_if_present() -> None:
    """
    Load ``KEY=value`` pairs from the first ``.env`` found, walking up from ``cwd``.

    - Skips empty lines and lines starting with ``#``.
    - Supports optional ``export `` prefix.
    - Does **not** override variables already set in the process environment.

    Uses only the standard library (no ``python-dotenv`` required).
    """
    path = _find_dotenv_upward()
    if path is None:
        return
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        if "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        if not key:
            continue
        val = val.strip()
        if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
            val = val[1:-1]
        if key not in os.environ:
            os.environ[key] = val


def _find_dotenv_upward() -> Path | None:
    here = Path.cwd().resolve()
    for directory in [here, *here.parents]:
        candidate = directory / ".env"
        if candidate.is_file():
            return candidate
    return None


def _get_env(name: str, default: str | None = None) -> str | None:
    value = os.getenv(name)
    if value is None or value == "":
        return default
    return value


def _get_env_int(name: str, default: int) -> int:
    raw = _get_env(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError as e:
        raise ValueError(f"Invalid integer for {name}: {raw!r}") from e


@dataclass(frozen=True, slots=True)
class Settings:
    """
    Configuration loaded from environment variables.

    ``from_env()`` first loads a repo-level ``.env`` (search upward from ``cwd``)
    if ``python-dotenv`` is not required—see ``load_dotenv_if_present``.

    Required:
    - LLAMA_CLOUD_API_KEY
    - If EMBED_PROVIDER=openai: OPENAI_API_KEY
    - If EMBED_PROVIDER=gemini: GEMINI_API_KEY
    """

    llama_cloud_api_key: str
    embed_provider: str = "openai"  # "openai" | "gemini"
    openai_api_key: str | None = None
    gemini_api_key: str | None = None

    faiss_dir: str = "faiss_store"
    embedding_model: str = "text-embedding-3-large"
    gemini_embedding_model: str = "text-embedding-004"
    embed_batch_size: int = 100

    chunk_config: ChunkConfig = ChunkConfig()

    @staticmethod
    def from_env() -> "Settings":
        load_dotenv_if_present()
        llama_key = _get_env("LLAMA_CLOUD_API_KEY")
        if not llama_key:
            raise ValueError("Missing required env var: LLAMA_CLOUD_API_KEY")

        embed_provider = (_get_env("EMBED_PROVIDER", "openai") or "openai").strip().lower()
        openai_key = _get_env("OPENAI_API_KEY")
        gemini_key = _get_env("GEMINI_API_KEY")
        if embed_provider == "openai" and not openai_key:
            raise ValueError("Missing required env var for EMBED_PROVIDER=openai: OPENAI_API_KEY")
        if embed_provider == "gemini" and not gemini_key:
            raise ValueError("Missing required env var for EMBED_PROVIDER=gemini: GEMINI_API_KEY")

        faiss_dir = _get_env("FAISS_DIR", "faiss_store") or "faiss_store"
        embedding_model = _get_env("OPENAI_EMBEDDING_MODEL", "text-embedding-3-large") or "text-embedding-3-large"
        gemini_embedding_model = _get_env("GEMINI_EMBEDDING_MODEL", "text-embedding-004") or "text-embedding-004"
        embed_batch_size = _get_env_int("EMBED_BATCH_SIZE", 100)

        chunk_cfg = ChunkConfig(
            target_chars=_get_env_int("CHUNK_TARGET_CHARS", 1200),
            max_chars=_get_env_int("CHUNK_MAX_CHARS", 1800),
            soft_min_chars=_get_env_int("CHUNK_SOFT_MIN_CHARS", 600),
            overlap_chars=_get_env_int("CHUNK_OVERLAP_CHARS", 160),
            keep_tables_atomic=_get_env("CHUNK_KEEP_TABLES_ATOMIC", "1") != "0",
            keep_warnings_atomic=_get_env("CHUNK_KEEP_WARNINGS_ATOMIC", "1") != "0",
            attach_captions_to_adjacent_text=_get_env("CHUNK_ATTACH_CAPTIONS", "1") != "0",
            include_heading_prefix=_get_env("CHUNK_INCLUDE_HEADING_PREFIX", "1") != "0",
        )

        return Settings(
            llama_cloud_api_key=llama_key,
            embed_provider=embed_provider,
            openai_api_key=openai_key,
            gemini_api_key=gemini_key,
            faiss_dir=faiss_dir,
            embedding_model=embedding_model,
            gemini_embedding_model=gemini_embedding_model,
            embed_batch_size=embed_batch_size,
            chunk_config=chunk_cfg,
        )

