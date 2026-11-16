"""Object storage over AWS S3.

The browser PUTs bytes straight to S3 using a presigned URL; this server never
touches file content on the way in. That is the whole point - the alternative
streams every upload through a worker and reintroduces the bottleneck presigned
URLs exist to avoid.

Postgres holds the keys these functions return; S3 holds the bytes. Nothing
outside this module knows which backend is underneath, so swapping providers
means reimplementing these six functions and nothing else.

Key layout:
    raw/{case_id}/{asset_id}/{filename}     original upload, untouched
    normalized/{case_id}/{asset_id}/...     EXIF-stripped, max 1920px
    thumbs/{case_id}/{asset_id}/...         256px preview
    manuals/{manual_id}.pdf                 source manuals
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from typing import Optional

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

from app.config import settings


class StorageError(RuntimeError):
    pass


@lru_cache
def _client():
    if not (settings.aws_access_key_id and settings.aws_secret_access_key):
        raise StorageError(
            "AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are not set - see backend/.env.example"
        )
    return boto3.client(
        "s3",
        region_name=settings.aws_region,
        aws_access_key_id=settings.aws_access_key_id,
        aws_secret_access_key=settings.aws_secret_access_key,
        # SigV4 is required for presigned PUTs in newer regions like ca-central-1.
        config=Config(signature_version="s3v4", retries={"max_attempts": 3}),
    )


def raw_key(case_id: str, asset_id: str, filename: str) -> str:
    return f"raw/{case_id}/{asset_id}/{filename}"


def derived_key(raw: str, kind: str) -> str:
    """raw/... -> normalized/... | thumbs/... | frames/..."""
    return raw.replace("raw/", f"{kind}/", 1)


async def create_signed_upload_url(
    key: str, content_type: str = "application/octet-stream"
) -> tuple[str, datetime]:
    """Returns (upload_url, expires_at). The client PUTs bytes to that URL.

    `content_type` is part of the signature, so the client must send the exact
    same Content-Type header on the PUT or S3 rejects it with 403.
    """
    ttl = settings.signed_url_ttl_seconds
    # Purely local signing - no network call, safe to run inline.
    url = _client().generate_presigned_url(
        "put_object",
        Params={
            "Bucket": settings.s3_bucket,
            "Key": key,
            "ContentType": content_type,
        },
        ExpiresIn=ttl,
    )
    return url, datetime.now(timezone.utc) + timedelta(seconds=ttl)


async def create_signed_download_url(key: str, ttl: Optional[int] = None) -> str:
    """Short-lived GET URL. The bucket stays private; nothing is world-readable.

    These are also what we hand to the model as image URLs, so it fetches from
    S3 directly instead of us base64-ing megabytes into every request.
    """
    return _client().generate_presigned_url(
        "get_object",
        Params={"Bucket": settings.s3_bucket, "Key": key},
        ExpiresIn=ttl or settings.signed_url_ttl_seconds,
    )


async def exists(key: str) -> bool:
    def _head() -> bool:
        try:
            _client().head_object(Bucket=settings.s3_bucket, Key=key)
            return True
        except ClientError as e:
            if e.response["Error"]["Code"] in ("404", "NoSuchKey", "403"):
                return False
            raise

    return await asyncio.to_thread(_head)


async def download(key: str) -> bytes:
    def _get() -> bytes:
        try:
            obj = _client().get_object(Bucket=settings.s3_bucket, Key=key)
            return obj["Body"].read()
        except ClientError as e:
            raise StorageError(f"download failed for {key}: {e}") from e

    return await asyncio.to_thread(_get)


async def upload(key: str, data: bytes, content_type: str) -> None:
    def _put() -> None:
        try:
            _client().put_object(
                Bucket=settings.s3_bucket,
                Key=key,
                Body=data,
                ContentType=content_type,
            )
        except ClientError as e:
            raise StorageError(f"upload failed for {key}: {e}") from e

    await asyncio.to_thread(_put)


async def delete(key: str) -> None:
    """Remove one object. Needed by retention and by orphan cleanup: when an
    upload is deduped, the duplicate's own bytes are left unreferenced because
    its row is repointed at the original's keys."""

    def _del() -> None:
        try:
            _client().delete_object(Bucket=settings.s3_bucket, Key=key)
        except ClientError as e:
            raise StorageError(f"delete failed for {key}: {e}") from e

    await asyncio.to_thread(_del)


async def healthy() -> bool:
    """True when the bucket exists and our credentials can see it."""

    def _head_bucket() -> bool:
        try:
            _client().head_bucket(Bucket=settings.s3_bucket)
            return True
        except Exception:
            return False

    try:
        return await asyncio.to_thread(_head_bucket)
    except Exception:
        return False
