"""Opera AI backend - FastAPI entrypoint.

Run locally:  uvicorn app.main:app --reload --port 8000
Health check: curl localhost:8000/health
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import assets, cases, events, ui_compat
from app.config import settings
from app.core import db, storage

log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Never let a bad dependency stop the app from booting. /health exists to
    # explain what is misconfigured, and it can't do that if a wrong
    # DATABASE_URL takes the process down before it can answer.
    if settings.database_url:
        try:
            await db.init_pool()
        except Exception as e:
            log.warning("database unavailable at startup: %s", e)
    yield
    await db.close_pool()


app = FastAPI(title="Opera AI Backend", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


app.include_router(cases.router)
app.include_router(assets.router)
app.include_router(events.router)
app.include_router(ui_compat.router)


@app.get("/health")
async def health() -> dict:
    """Reports what is configured and what actually answers.

    `configured` means a value is present in .env; `reachable` means we talked
    to it. A configured-but-unreachable dependency is the usual setup failure.
    """
    db_configured = bool(settings.database_url)
    storage_configured = bool(
        settings.aws_access_key_id
        and settings.aws_secret_access_key
        and settings.s3_bucket
    )

    checks = {
        "openrouter": {"configured": bool(settings.openrouter_api_key)},
        "database": {
            "configured": db_configured,
            "reachable": await db.healthy() if db_configured else None,
        },
        "storage": {
            "configured": storage_configured,
            "bucket": settings.s3_bucket,
            "region": settings.aws_region,
            "reachable": await storage.healthy() if storage_configured else None,
        },
        "auth": {"configured": bool(settings.api_bearer_token)},
    }

    manuals = sorted(p.name for p in settings.manuals_dir.glob("*.pdf"))
    ready = all(
        c.get("configured") and c.get("reachable") is not False for c in checks.values()
    )

    return {
        "status": "ok" if ready else "incomplete",
        "checks": checks,
        "manuals_on_disk": manuals,
        "models": {
            "diagnose": settings.model_diagnose,
            "default": settings.model_default,
            "cheap": settings.model_cheap,
        },
    }


@app.get("/")
async def root() -> dict:
    return {"service": "opera-ai-backend", "docs": "/docs", "health": "/health"}
