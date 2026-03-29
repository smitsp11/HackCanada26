from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Iterable, Protocol


class Embedder(Protocol):
    def embed_text(self, text: str) -> list[float]: ...

    def embed_texts(self, texts: list[str]) -> list[list[float]]: ...

    @staticmethod
    def infer_dim(embedding: Iterable[float]) -> int: ...


@dataclass(frozen=True, slots=True)
class OpenAIEmbedder:
    """
    OpenAI embeddings adapter.

    Uses the OpenAI Python SDK and the Embeddings API.
    Large inputs are embedded in batches to stay within API limits.
    """

    api_key: str
    model: str
    batch_size: int = 100

    def __post_init__(self) -> None:
        if not self.api_key:
            raise ValueError("api_key must be non-empty")
        if not self.model:
            raise ValueError("model must be non-empty")
        if self.batch_size <= 0:
            raise ValueError("batch_size must be > 0")

    def embed_text(self, text: str) -> list[float]:
        if text.strip() == "":
            raise ValueError("Cannot embed empty text")
        from openai import OpenAI

        client = OpenAI(api_key=self.api_key)
        resp = client.embeddings.create(model=self.model, input=text)
        return list(resp.data[0].embedding)

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        cleaned: list[str] = []
        for t in texts:
            if t.strip() == "":
                raise ValueError("Cannot embed empty text in batch")
            cleaned.append(t)

        from openai import OpenAI

        client = OpenAI(api_key=self.api_key)
        out: list[list[float]] = []
        for i in range(0, len(cleaned), self.batch_size):
            batch = cleaned[i : i + self.batch_size]
            resp = client.embeddings.create(model=self.model, input=batch)
            # SDK returns embeddings in the same order as `input`.
            out.extend(list(item.embedding) for item in resp.data)
        return out

    @staticmethod
    def infer_dim(embedding: Iterable[float]) -> int:
        vec = list(embedding)
        if not vec:
            raise ValueError("Invalid embedding vector")
        return int(len(vec))


@dataclass(frozen=True, slots=True)
class GeminiEmbedder:
    """
    Gemini embeddings adapter (REST) using Google Generative Language API.

    No extra dependencies required (uses `urllib`).
    """

    api_key: str
    model: str = "text-embedding-004"
    batch_size: int = 50
    task_type: str = "RETRIEVAL_DOCUMENT"

    def __post_init__(self) -> None:
        if not self.api_key:
            raise ValueError("api_key must be non-empty")
        if not self.model:
            raise ValueError("model must be non-empty")
        if self.batch_size <= 0:
            raise ValueError("batch_size must be > 0")

    def embed_text(self, text: str) -> list[float]:
        if text.strip() == "":
            raise ValueError("Cannot embed empty text")
        resp = self._post_json(
            endpoint=f"models/{self.model}:embedContent",
            payload={
                "content": {"parts": [{"text": text}]},
                "taskType": self.task_type,
            },
        )
        emb = resp.get("embedding", {}).get("values")
        if not isinstance(emb, list) or not emb:
            raise ValueError("Gemini embedding response missing `embedding.values`")
        return [float(x) for x in emb]

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        cleaned: list[str] = []
        for t in texts:
            if t.strip() == "":
                raise ValueError("Cannot embed empty text in batch")
            cleaned.append(t)
        if not cleaned:
            return []

        out: list[list[float]] = []
        for i in range(0, len(cleaned), self.batch_size):
            batch = cleaned[i : i + self.batch_size]
            requests = [
                {
                    "model": f"models/{self.model}",
                    "content": {"parts": [{"text": t}]},
                    "taskType": self.task_type,
                }
                for t in batch
            ]
            resp = self._post_json(
                endpoint=f"models/{self.model}:batchEmbedContents",
                payload={"requests": requests},
            )
            embeddings = resp.get("embeddings")
            if not isinstance(embeddings, list) or len(embeddings) != len(batch):
                raise ValueError("Gemini batch embedding response has unexpected shape")
            for item in embeddings:
                values = (item or {}).get("values") if isinstance(item, dict) else None
                if not isinstance(values, list) or not values:
                    raise ValueError("Gemini batch embedding item missing `values`")
                out.append([float(x) for x in values])
        return out

    def _post_json(self, endpoint: str, payload: dict) -> dict:
        url = f"https://generativelanguage.googleapis.com/v1beta/{endpoint}?key={self.api_key}"
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=data,
            method="POST",
            headers={"content-type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                body = res.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace") if hasattr(e, "read") else str(e)
            raise RuntimeError(f"Gemini embeddings HTTP {e.code}: {body}") from e
        except urllib.error.URLError as e:
            raise RuntimeError(f"Gemini embeddings request failed: {e}") from e

        try:
            parsed = json.loads(body)
        except json.JSONDecodeError as e:
            raise RuntimeError(f"Gemini embeddings returned non-JSON: {body[:200]}") from e
        if not isinstance(parsed, dict):
            raise RuntimeError("Gemini embeddings returned unexpected JSON")
        return parsed

    @staticmethod
    def infer_dim(embedding: Iterable[float]) -> int:
        vec = list(embedding)
        if not vec:
            raise ValueError("Invalid embedding vector")
        return int(len(vec))

