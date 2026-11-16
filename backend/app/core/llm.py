"""Model access via OpenRouter (OpenAI-compatible surface, Gemini underneath).

The one non-obvious thing in this file is the PDF plugin. OpenRouter defaults
to text-extracting PDFs before they reach the model, which destroys anything
that lives as an image on the page - and in appliance manuals the troubleshooting
flowcharts and status-code tables are exactly that. Passing
`{"engine": "native"}` hands the rendered pages to Gemini's own vision instead.

Verified against a PDF with zero extractable text: Gemini read values that only
existed as pixels. Do not remove the plugin block.
"""

from __future__ import annotations

import base64
import json
import mimetypes
import re
import time
from pathlib import Path
from typing import Any, Optional

import httpx

from app.config import settings

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

# Roughly 1,300 prompt tokens per rendered PDF page, measured. Used for cost
# estimates and for refusing to send something absurd.
TOKENS_PER_PDF_PAGE = 1300


class LLMError(RuntimeError):
    pass


# --------------------------------------------------------------------------
# Content part builders
# --------------------------------------------------------------------------


def text_part(text: str) -> dict[str, Any]:
    return {"type": "text", "text": text}


def image_part(data: bytes, mime_type: str = "image/jpeg") -> dict[str, Any]:
    b64 = base64.b64encode(data).decode()
    return {"type": "image_url", "image_url": {"url": f"data:{mime_type};base64,{b64}"}}


def image_url_part(url: str) -> dict[str, Any]:
    """Prefer this over base64 when we already have a signed GET URL."""
    return {"type": "image_url", "image_url": {"url": url}}


def pdf_part(data: bytes, filename: str = "manual.pdf") -> dict[str, Any]:
    b64 = base64.b64encode(data).decode()
    return {
        "type": "file",
        "file": {"filename": filename, "file_data": f"data:application/pdf;base64,{b64}"},
    }


def pdf_url_part(url: str, filename: str = "manual.pdf") -> dict[str, Any]:
    """Reference a PDF by URL instead of inlining its bytes.

    The provider fetches it from storage directly, so a 16 MB manual is not
    re-uploaded from this process on every call. Pass a presigned S3 URL.
    """
    return {"type": "file", "file": {"filename": filename, "file_data": url}}


def pdf_part_from_path(path: str | Path) -> dict[str, Any]:
    p = Path(path)
    return pdf_part(p.read_bytes(), filename=p.name)


def file_part_for(path: str | Path) -> dict[str, Any]:
    """Dispatch on file type - PDFs become documents, images become images."""
    p = Path(path)
    mime = mimetypes.guess_type(p.name)[0] or "application/octet-stream"
    if mime == "application/pdf":
        return pdf_part(p.read_bytes(), filename=p.name)
    if mime.startswith("image/"):
        return image_part(p.read_bytes(), mime_type=mime)
    raise LLMError(f"unsupported file type for {p.name}: {mime}")


# --------------------------------------------------------------------------
# Client
# --------------------------------------------------------------------------


class LLM:
    """Thin async wrapper. One method, two modes: free text or JSON schema."""

    def __init__(self, api_key: Optional[str] = None, timeout: float = 180.0):
        self.api_key = api_key or settings.openrouter_api_key
        self.timeout = timeout

    async def complete(
        self,
        parts: list[dict[str, Any]],
        *,
        model: Optional[str] = None,
        system: Optional[str] = None,
        schema: Optional[dict[str, Any]] = None,
        schema_name: str = "response",
        max_tokens: int = 8000,
        temperature: float = 0.2,
        has_pdf: bool = False,
        reasoning: Optional[dict[str, Any]] = None,
        timeout: Optional[float] = None,
    ) -> tuple[Any, dict[str, Any]]:
        """Send one request. Returns (content, usage).

        With `schema`, content is a parsed dict validated by the provider where
        supported and defensively parsed here where not. Without it, content is
        the raw string.
        """
        model = model or settings.model_default

        messages: list[dict[str, Any]] = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": parts})

        body: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
        }

        # See module docstring - this is what keeps diagrams readable.
        if has_pdf or any(p.get("type") == "file" for p in parts):
            body["plugins"] = [{"id": "file-parser", "pdf": {"engine": "native"}}]

        if schema:
            body["response_format"] = {
                "type": "json_schema",
                "json_schema": {"name": schema_name, "strict": True, "schema": schema},
            }

        if reasoning:
            # e.g. {"effort": "low"} or {"max_tokens": 2048}; OpenRouter maps it
            # onto the provider's thinking budget.
            body["reasoning"] = reasoning

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            # OpenRouter attribution headers - optional but good manners.
            "HTTP-Referer": settings.public_url,
            "X-Title": "Opera AI",
        }

        encoded = json.dumps(body).encode()
        started = time.monotonic()
        async with httpx.AsyncClient(timeout=timeout or self.timeout) as client:
            resp = await client.post(
                OPENROUTER_URL, content=encoded, headers=headers
            )
        elapsed = time.monotonic() - started

        if resp.status_code != 200:
            raise LLMError(f"openrouter {resp.status_code}: {resp.text[:500]}")

        payload = resp.json()
        if "error" in payload:
            raise LLMError(f"openrouter error: {json.dumps(payload['error'])[:500]}")

        choice = payload["choices"][0]["message"]
        content = choice.get("content") or ""
        raw_usage = payload.get("usage", {})
        details = raw_usage.get("completion_tokens_details") or {}
        # Timing and size recorded on every call. Without them a slow stage
        # can't be attributed to upload, reasoning or provider queueing.
        usage = raw_usage | {
            "model": payload.get("model", model),
            "latency_s": round(elapsed, 2),
            "request_mb": round(len(encoded) / 1e6, 2),
            "reasoning_tokens": details.get("reasoning_tokens"),
            # "length" means the output hit max_tokens; with a JSON schema that
            # is a truncated, unparseable response and a full-cost retry.
            "finish_reason": payload["choices"][0].get("finish_reason"),
        }

        if schema:
            try:
                return _parse_json(content), usage
            except LLMError as e:
                # Record why: finish_reason "length" with most of the budget spent
                # on reasoning means the answer never started - raise max_tokens,
                # don't retry with the same limit.
                raise LLMError(
                    f"{e} [finish={usage.get('finish_reason')} "
                    f"completion={usage.get('completion_tokens')} "
                    f"reasoning={usage.get('reasoning_tokens')} max_tokens={max_tokens}]"
                ) from None
        return content, usage


def _parse_json(content: str) -> dict[str, Any]:
    """Parse model JSON defensively.

    Structured-output support varies by model and provider, so a response may
    arrive fenced in markdown or with prose around it. Try strict first, then
    recover the outermost JSON object.
    """
    content = content.strip()
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        pass

    fenced = re.search(r"```(?:json)?\s*(.*?)```", content, re.DOTALL)
    if fenced:
        try:
            return json.loads(fenced.group(1).strip())
        except json.JSONDecodeError:
            pass

    start, end = content.find("{"), content.rfind("}")
    if start != -1 and end > start:
        try:
            return json.loads(content[start : end + 1])
        except json.JSONDecodeError:
            pass

    raise LLMError(f"could not parse JSON from model output: {content[:300]}")


llm = LLM()
