"""Settings loaded from backend/.env. Copy .env.example and fill it in."""

from __future__ import annotations

from functools import lru_cache
from typing import Optional
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=BASE_DIR / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- models (all calls route through OpenRouter) ---
    openrouter_api_key: str = ""
    # Reasoning-critical stage. Diagnosis quality is the product.
    model_diagnose: str = "google/gemini-2.5-pro"
    # Everything else: identification, parts, instructions.
    model_default: str = "google/gemini-2.5-flash"
    # Cheap verification and schema-conversion passes.
    model_cheap: str = "google/gemini-2.5-flash-lite"
    # Served through OpenRouter's OpenAI-compatible /embeddings endpoint, so it
    # rides the same key. 1536 dims - must match manual_pages.embedding.
    model_embedding: str = "openai/text-embedding-3-small"

    # --- retrieval ---
    # When on, diagnose reads the top-k retrieved manual pages instead of the
    # whole PDF. Off keeps the original full-manual behaviour.
    retrieval_enabled: bool = False
    retrieval_top_k: int = 8

    # Diagnosis tuning. Defaults reproduce the original behaviour; see
    # eval/diagnose_configs.py for the measurements behind any change.
    diagnose_manual_via_url: bool = False
    diagnose_reasoning_effort: Optional[str] = None  # "low" | "medium" | "high"
    # Must clear the slowest normal diagnosis with margin: a timeout triggers a
    # retry, and a retry restarts the whole call from zero.
    diagnose_timeout_s: float = 300.0
    # Reasoning tokens count against max_tokens, so a tight cap can leave no
    # room for the answer itself - an unparseable response and a full retry.
    # A higher cap doesn't change how the model reasons, only whether it's cut off.
    diagnose_max_tokens: int = 24000

    # --- persistence ---
    database_url: str = ""

    # --- storage (AWS S3; swap providers by replacing core/storage.py) ---
    aws_access_key_id: str = ""
    aws_secret_access_key: str = ""
    aws_region: str = "ca-central-1"
    s3_bucket: str = ""

    # --- api ---
    api_bearer_token: str = ""
    public_url: str = "http://localhost:8000"
    cors_origins: str = "http://localhost:3000,http://localhost:3001"

    # --- limits ---
    max_image_bytes: int = 20 * 1024 * 1024
    max_video_bytes: int = 200 * 1024 * 1024
    max_video_seconds: int = 30
    max_assets_per_case: int = 10
    signed_url_ttl_seconds: int = 600

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def manuals_dir(self) -> Path:
        return BASE_DIR / "manuals"


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
