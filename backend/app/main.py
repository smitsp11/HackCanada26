from __future__ import annotations

import json
import os
from typing import Any, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel


load_dotenv()


class IdentifyRequest(BaseModel):
    imageUrl: str


class Product(BaseModel):
    id: int
    company: str
    model_number: str
    display_name: Optional[str] = None
    product_type: Optional[str] = None


class IdentifyResponse(BaseModel):
    product: Optional[Product] = None
    source: str = "none"  # "ocr" | "gemini" | "none"
    parsedBrand: Optional[str] = None
    parsedModel: Optional[str] = None


class ProcessResponse(BaseModel):
    annotatedUrl: Optional[str] = None


def _json_error(status_code: int, message: str, detail: Optional[str] = None) -> None:
    raise HTTPException(status_code=status_code, detail=detail or message)


app = FastAPI(title="Opera AI Backend (FastAPI)")

allowed_origins = [
    os.getenv("CORS_ORIGIN", "http://localhost:3000"),
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/identify-product", response_model=IdentifyResponse)
def identify_product(payload: IdentifyRequest) -> IdentifyResponse:
    # Placeholder implementation.
    # Keep response shape stable for the frontend.
    if not payload.imageUrl:
        _json_error(400, "imageUrl is required")
    return IdentifyResponse(product=None, source="none")


@app.post("/api/process", response_model=ProcessResponse)
async def process(
    file: UploadFile = File(...),
    step: str = Form(...),
) -> ProcessResponse:
    # Expected by frontend: multipart form with fields:
    # - file: uploaded image
    # - step: JSON string containing step payload
    if not file.filename:
        _json_error(400, "file is required")

    try:
        step_obj: Any = json.loads(step)
    except Exception as e:  # noqa: BLE001
        _json_error(400, "Invalid step JSON", detail=str(e))

    if not isinstance(step_obj, dict) or "step" not in step_obj:
        _json_error(400, "step payload missing required fields")

    # Placeholder: read the file to ensure upload works end-to-end.
    await file.read()

    # TODO: Replace with Cloudinary + Gemini pipeline.
    return ProcessResponse(annotatedUrl=None)

