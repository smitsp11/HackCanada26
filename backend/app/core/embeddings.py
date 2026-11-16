"""Text embeddings via OpenRouter's OpenAI-compatible /embeddings endpoint.

Same key as every other model call. Vectors are returned as pgvector literals
('[0.1,0.2,...]') because asyncpg has no codec for the vector type and a text
literal cast with ::vector is the least surprising way across.
"""

from __future__ import annotations

from typing import Any

import httpx

from app.config import settings
from app.core.llm import LLMError

OPENROUTER_EMBEDDINGS_URL = "https://openrouter.ai/api/v1/embeddings"

# text-embedding-3-small caps inputs at 8191 tokens; manual pages run ~1.5k.
MAX_INPUT_CHARS = 24_000


async def embed(texts: list[str], *, model: str | None = None) -> tuple[list[list[float]], dict[str, Any]]:
    """Returns (vectors in input order, usage)."""
    model = model or settings.model_embedding
    body = {"model": model, "input": [t[:MAX_INPUT_CHARS] for t in texts]}
    headers = {
        "Authorization": f"Bearer {settings.openrouter_api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": settings.public_url,
        "X-Title": "Opera AI",
    }
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(OPENROUTER_EMBEDDINGS_URL, json=body, headers=headers)
    if resp.status_code != 200:
        raise LLMError(f"openrouter embeddings {resp.status_code}: {resp.text[:500]}")
    payload = resp.json()
    if "error" in payload:
        raise LLMError(f"openrouter embeddings error: {payload['error']}")
    rows = sorted(payload["data"], key=lambda d: d["index"])
    return [r["embedding"] for r in rows], payload.get("usage", {}) | {"model": model}


def to_pgvector(vec: list[float]) -> str:
    return "[" + ",".join(f"{x:.7g}" for x in vec) + "]"
