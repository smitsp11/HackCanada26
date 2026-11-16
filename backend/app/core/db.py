"""Postgres access: one asyncpg pool, raw parameterised SQL, no ORM."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Optional

import asyncpg

from app.config import BASE_DIR, settings

_pool: Optional[asyncpg.Pool] = None


async def init_pool() -> asyncpg.Pool:
    global _pool
    if _pool is None:
        if not settings.database_url:
            raise RuntimeError("DATABASE_URL is not set - see backend/.env.example")
        _pool = await asyncpg.create_pool(
            settings.database_url,
            min_size=1,
            max_size=10,
            # Supabase's pooler does not support prepared statement caching.
            statement_cache_size=0,
            init=_register_json_codecs,
        )
    return _pool


def _json_encode(value: Any) -> str:
    """Serialize for JSONB, tolerating an already-serialized string.

    Without the passthrough, a caller who helpfully does `json.dumps(...)`
    before binding gets their JSON double-encoded: it stores as a JSON *string*
    containing JSON, and reads back as `str` instead of `dict`. The failure is
    silent until something downstream does `row["output"]["brand"]`.
    """
    return value if isinstance(value, str) else json.dumps(value)


async def _register_json_codecs(conn: asyncpg.Connection) -> None:
    """Hand back JSONB as dicts rather than strings."""
    for typename in ("jsonb", "json"):
        await conn.set_type_codec(
            typename, encoder=_json_encode, decoder=json.loads, schema="pg_catalog"
        )


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


def pool() -> asyncpg.Pool:
    if _pool is None:
        raise RuntimeError("db pool not initialised - call init_pool() on startup")
    return _pool


async def fetch(query: str, *args: Any) -> list[asyncpg.Record]:
    async with pool().acquire() as conn:
        return await conn.fetch(query, *args)


async def fetchrow(query: str, *args: Any) -> Optional[asyncpg.Record]:
    async with pool().acquire() as conn:
        return await conn.fetchrow(query, *args)


async def fetchval(query: str, *args: Any) -> Any:
    async with pool().acquire() as conn:
        return await conn.fetchval(query, *args)


async def execute(query: str, *args: Any) -> str:
    async with pool().acquire() as conn:
        return await conn.execute(query, *args)


async def migrate() -> None:
    """Apply every .sql file in migrations/ in filename order.

    The files use CREATE TABLE IF NOT EXISTS throughout, so re-running is safe.
    """
    migrations_dir = BASE_DIR / "migrations"
    files = sorted(migrations_dir.glob("*.sql"))
    if not files:
        raise RuntimeError(f"no migrations found in {migrations_dir}")
    async with pool().acquire() as conn:
        for path in files:
            await conn.execute(Path(path).read_text())


async def healthy() -> bool:
    try:
        return await fetchval("SELECT 1") == 1
    except Exception:
        return False
