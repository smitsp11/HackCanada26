"""The presigned upload path, exercised against the real S3 bucket and Postgres.

    ./.venv/bin/python -m pytest tests/test_assets.py -v

No mocks. A presigned URL that is not actually PUT-able is the exact failure
these tests exist to catch, and a fake S3 cannot catch it. Every case created
here is deleted on teardown, together with everything under its raw/ prefix.

`client.portal` is the anyio portal TestClient runs the app in; calling async
helpers through it is how a test reaches the same asyncpg pool the app is using
(a pool is bound to the loop that created it).
"""

from __future__ import annotations

import functools
import hashlib
import uuid
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app.api import assets as assets_api
from app.config import settings
from app.core import db, storage, validation
from app.main import app
from app.schemas.contracts import AssetRole

FIXTURE = Path(__file__).resolve().parent.parent / "fixtures" / "opera-img1.png"
AUTH = {"Authorization": f"Bearer {settings.api_bearer_token}"}

REGISTER_PATH = "/api/cases/{case_id}/assets/register"

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
JPEG_BYTES = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01" + b"\x00" * 64
WAV_BYTES = b"RIFF\x24\x00\x00\x00WAVEfmt " + b"\x00" * 64
AVI_BYTES = b"RIFF\x24\x00\x00\x00AVI LIST" + b"\x00" * 64
WEBP_BYTES = b"RIFF\x24\x00\x00\x00WEBPVP8 " + b"\x00" * 64
MP4_BYTES = b"\x00\x00\x00\x18ftypisom" + b"\x00" * 64
MOV_BYTES = b"\x00\x00\x00\x14ftypqt  " + b"\x00" * 64
WEBM_BYTES = b"\x1a\x45\xdf\xa3" + b"\x00" * 64


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def client():
    # main.py does not mount this router yet (it is wired separately), so the
    # suite mounts it itself and stays honest about the real app object.
    if not any(
        getattr(r, "path", "") == "/api/cases/{case_id}/assets/register"
        for r in app.routes
    ):
        app.include_router(assets_api.router)
    with TestClient(app) as c:
        yield c


def run(client: TestClient, fn, *args):
    """Run an app-side coroutine on the app's own event loop."""
    return client.portal.call(functools.partial(fn, *args))


def _purge_prefix(case_id: str) -> None:
    try:
        s3 = storage._client()
        listing = s3.list_objects_v2(Bucket=settings.s3_bucket, Prefix=f"raw/{case_id}/")
        keys = [{"Key": o["Key"]} for o in listing.get("Contents", [])]
        if keys:
            s3.delete_objects(Bucket=settings.s3_bucket, Delete={"Objects": keys})
    except Exception:  # cleanup must never fail a test run
        pass


@pytest.fixture
def case(client: TestClient):
    r = client.post("/api/cases", json={"appliance_type_hint": "test"}, headers=AUTH)
    assert r.status_code == 201, r.text
    case_id = r.json()["case_id"]
    yield case_id
    # assets cascade with the case row.
    run(client, db.execute, "DELETE FROM cases WHERE case_id=$1", case_id)
    _purge_prefix(case_id)


def register(
    client: TestClient,
    case_id: str,
    *,
    filename: str = "opera-img1.png",
    mime_type: str = "image/png",
    role: str = AssetRole.NAMEPLATE.value,
    size_bytes: Any = None,
) -> httpx.Response:
    body: dict[str, Any] = {"filename": filename, "mime_type": mime_type, "role": role}
    if size_bytes is not None:
        body["size_bytes"] = size_bytes
    return client.post(REGISTER_PATH.format(case_id=case_id), json=body, headers=AUTH)


def put(url: str, data: bytes, content_type: str) -> httpx.Response:
    return httpx.put(url, content=data, headers={"Content-Type": content_type}, timeout=60)


def complete(client: TestClient, case_id: str, asset_id: str) -> httpx.Response:
    return client.post(
        f"/api/cases/{case_id}/assets/{asset_id}/complete", headers=AUTH
    )


def upload(
    client: TestClient,
    case_id: str,
    data: bytes,
    *,
    mime_type: str = "image/png",
    filename: str = "opera-img1.png",
    role: str = AssetRole.NAMEPLATE.value,
) -> str:
    """register + real PUT, stopping short of /complete."""
    r = register(client, case_id, filename=filename, mime_type=mime_type, role=role)
    assert r.status_code == 201, r.text
    body = r.json()
    assert put(body["upload_url"], data, mime_type).status_code == 200
    return body["asset_id"]


# ---------------------------------------------------------------------------
# Pure validation rules
# ---------------------------------------------------------------------------


def test_mime_allowlist_is_role_aware():
    for mime in ("image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"):
        assert validation.is_allowed_mime(mime, AssetRole.NAMEPLATE)
        assert not validation.is_allowed_mime(mime, AssetRole.VIDEO)
    for mime in ("video/mp4", "video/quicktime", "video/webm"):
        assert validation.is_allowed_mime(mime, AssetRole.VIDEO)
        # A video under an image role would be size-checked as an image.
        assert not validation.is_allowed_mime(mime, AssetRole.INTERIOR)
    for mime in ("image/gif", "application/pdf", "text/html", "", None):
        assert not validation.is_allowed_mime(mime, AssetRole.OTHER)
    # Parameters and casing are noise, not a rejection reason.
    assert validation.is_allowed_mime("IMAGE/PNG; charset=binary", AssetRole.OTHER)


def test_magic_bytes_accept_genuine_signatures():
    assert validation.check_magic_bytes(FIXTURE.read_bytes(), "image/png")
    assert validation.check_magic_bytes(JPEG_BYTES, "image/jpeg")
    assert validation.check_magic_bytes(WEBP_BYTES, "image/webp")
    assert validation.check_magic_bytes(MP4_BYTES, "video/mp4")
    assert validation.check_magic_bytes(MOV_BYTES, "video/quicktime")
    assert validation.check_magic_bytes(WEBM_BYTES, "video/webm")


def test_webp_check_requires_the_fourcc_not_just_riff():
    """WAV and AVI are RIFF containers too; only the fourCC at offset 8 differs."""
    assert WAV_BYTES[:4] == b"RIFF" and AVI_BYTES[:4] == b"RIFF"
    assert not validation.check_magic_bytes(WAV_BYTES, "image/webp")
    assert not validation.check_magic_bytes(AVI_BYTES, "image/webp")
    assert not validation.check_magic_bytes(b"RIFF\x00\x00\x00\x00", "image/webp")


def test_magic_bytes_reject_mismatches_and_junk():
    assert not validation.check_magic_bytes(JPEG_BYTES, "image/png")
    assert not validation.check_magic_bytes(FIXTURE.read_bytes()[:64], "image/jpeg")
    assert not validation.check_magic_bytes(MP4_BYTES, "image/heic")
    assert not validation.check_magic_bytes(b"", "image/png")
    assert not validation.check_magic_bytes(b"#!/bin/sh\nrm -rf /\n", "image/png")
    assert not validation.check_magic_bytes(FIXTURE.read_bytes(), "application/pdf")


def test_validate_size_uses_the_role_limit():
    validation.validate_size(settings.max_image_bytes, AssetRole.NAMEPLATE)
    validation.validate_size(settings.max_video_bytes, AssetRole.VIDEO)
    # An image-sized limit would reject this; the video role must not.
    validation.validate_size(settings.max_image_bytes + 1, AssetRole.VIDEO)
    with pytest.raises(validation.ValidationError) as e:
        validation.validate_size(settings.max_image_bytes + 1, AssetRole.NAMEPLATE)
    assert e.value.status_code == 413


def test_compute_checksum_is_sha256():
    data = FIXTURE.read_bytes()
    assert validation.compute_checksum(data) == hashlib.sha256(data).hexdigest()


# ---------------------------------------------------------------------------
# register
# ---------------------------------------------------------------------------


def test_register_requires_auth(client, case):
    r = client.post(REGISTER_PATH.format(case_id=case), json={
        "filename": "x.png", "mime_type": "image/png", "role": "nameplate"})
    assert r.status_code == 401


def test_register_unknown_case_is_404(client):
    r = register(client, f"case_{uuid.uuid4().hex}")
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# Request dialects: the shipped client sends slot_key/asset_type, the frozen
# contract declares role. Both have to land on the same AssetRole.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "body, expected",
    [
        ({"asset_type": "image", "slot_key": "model"}, "nameplate"),
        ({"asset_type": "image", "slot_key": "additional"}, "interior"),
        ({"asset_type": "image", "slot_key": "unrecognised"}, "other"),
        ({"asset_type": "image"}, "other"),
        ({}, "other"),
        # role wins over a contradicting slot_key.
        ({"role": "interior", "slot_key": "model"}, "interior"),
    ],
)
def test_client_dialect_normalizes_to_a_role(client, case, body, expected):
    payload = {"filename": "shot.png", "mime_type": "image/png", "size_bytes": 1024}
    payload.update(body)
    r = client.post(REGISTER_PATH.format(case_id=case), json=payload, headers=AUTH)
    assert r.status_code == 201, r.text
    assert r.json()["role"] == expected

    row = run(client, db.fetchrow,
              "SELECT * FROM assets WHERE asset_id=$1", r.json()["asset_id"])
    assert row["role"] == expected
    assert row["size_bytes"] == 1024


@pytest.mark.parametrize("body", [
    {"asset_type": "video", "slot_key": "video"},
    {"asset_type": "video"},
    {"slot_key": "video"},
])
def test_client_dialect_resolves_the_video_role(client, case, body):
    payload = {
        "filename": "clip.mp4",
        "mime_type": "video/mp4",
        # Over the image limit: proves the video role picked up the video limit.
        "size_bytes": settings.max_image_bytes + 1,
    }
    payload.update(body)
    r = client.post(REGISTER_PATH.format(case_id=case), json=payload, headers=AUTH)
    assert r.status_code == 201, r.text
    assert r.json()["role"] == "video"
    assert r.json()["content_type"] == "video/mp4"


def test_slot_key_is_echoed_back(client, case):
    r = client.post(REGISTER_PATH.format(case_id=case), headers=AUTH, json={
        "filename": "shot.png", "mime_type": "image/png",
        "asset_type": "image", "slot_key": "model"})
    assert r.json()["slot_key"] == "model"


def test_unknown_role_is_rejected(client, case):
    r = register(client, case, role="thumbnail")
    assert r.status_code == 400
    assert "thumbnail" in r.json()["error"]


def test_errors_carry_a_top_level_error_key(client, case):
    """The client reads body.error; FastAPI's default `detail` reads as generic."""
    unauth = client.post(REGISTER_PATH.format(case_id=case), json={
        "filename": "x.png", "mime_type": "image/png", "role": "nameplate"})
    missing = register(client, f"case_{uuid.uuid4().hex}")
    bad_body = client.post(REGISTER_PATH.format(case_id=case), headers=AUTH,
                           json={"mime_type": ["not", "a", "string"]})

    assert (unauth.status_code, missing.status_code, bad_body.status_code) == (401, 404, 422)
    for r in (unauth, missing, bad_body):
        body = r.json()
        assert isinstance(body.get("error"), str) and body["error"], r.text
        assert "detail" not in body, r.text
    assert "mime_type" in bad_body.json()["error"]


def test_register_rejects_disallowed_mime(client, case):
    assert register(client, case, mime_type="application/pdf").status_code == 400
    assert register(client, case, mime_type="video/mp4").status_code == 400  # image role


def test_register_rejects_blank_filename(client, case):
    assert register(client, case, filename="   ").status_code == 400


def test_register_oversize_is_413(client, case):
    r = register(client, case, size_bytes=settings.max_image_bytes + 1)
    assert r.status_code == 413, r.text
    assert "exceeds" in r.json()["error"]


def test_register_quota_exceeded_is_429(client, case):
    for _ in range(settings.max_assets_per_case):
        assert register(client, case).status_code == 201
    r = register(client, case)
    assert r.status_code == 429, r.text
    assert str(settings.max_assets_per_case) in r.json()["error"]


def test_register_returns_a_usable_presigned_url(client, case):
    data = FIXTURE.read_bytes()
    r = register(client, case)
    assert r.status_code == 201, r.text
    body = r.json()

    assert body["asset_id"].startswith("asset_")
    assert body["storage_path"] == f"raw/{case}/{body['asset_id']}/opera-img1.png"
    assert "X-Amz-Signature" in body["upload_url"]
    assert body["expires_at"]
    # The signed Content-Type has to reach the client somehow, and the frozen
    # response model has no field for it.
    assert r.headers[assets_api.CONTENT_TYPE_HEADER] == "image/png"
    assert body["content_type"] == "image/png"
    assert body["upload_method"] == "PUT"
    assert body["upload_provider"] == "s3"

    row = run(client, db.fetchrow,
              "SELECT * FROM assets WHERE asset_id=$1", body["asset_id"])
    assert row["status"] == "awaiting_upload"
    assert row["storage_key_raw"] == body["storage_path"]
    assert row["checksum"] is None

    assert put(body["upload_url"], data, "image/png").status_code == 200
    assert run(client, storage.exists, body["storage_path"]) is True


def test_presigned_url_rejects_a_different_content_type(client, case):
    """Content-Type is inside the signature - this is why register echoes it."""
    body = register(client, case).json()
    assert put(body["upload_url"], FIXTURE.read_bytes(), "image/jpeg").status_code == 403


# ---------------------------------------------------------------------------
# complete
# ---------------------------------------------------------------------------


def test_complete_unknown_asset_is_404(client, case):
    assert complete(client, case, "asset_doesnotexist").status_code == 404


def test_complete_before_the_put_is_400(client, case):
    asset_id = register(client, case).json()["asset_id"]
    r = complete(client, case, asset_id)
    assert r.status_code == 400
    assert "PUT" in r.json()["error"]


def test_register_put_complete_end_to_end(client, case):
    data = FIXTURE.read_bytes()
    asset_id = upload(client, case, data)

    r = complete(client, case, asset_id)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "uploaded"
    assert body["duplicate"] is False
    assert body["checksum"] == hashlib.sha256(data).hexdigest()
    assert body["size_bytes"] == len(data)
    assert body["width"] and body["height"]

    row = run(client, db.fetchrow, "SELECT * FROM assets WHERE asset_id=$1", asset_id)
    assert (row["status"], row["checksum"], row["size_bytes"]) == (
        "uploaded", body["checksum"], len(data))
    assert (row["width"], row["height"]) == (body["width"], body["height"])


def test_complete_is_idempotent(client, case):
    asset_id = upload(client, case, FIXTURE.read_bytes())
    first = complete(client, case, asset_id).json()

    second = complete(client, case, asset_id)
    assert second.status_code == 200
    body = second.json()
    assert body["idempotent"] is True
    assert body["status"] == first["status"] == "uploaded"
    assert body["checksum"] == first["checksum"]
    assert body["size_bytes"] == first["size_bytes"]
    assert body["duplicate"] is False


def test_declared_mime_contradicting_the_bytes_is_rejected(client, case):
    asset_id = upload(client, case, JPEG_BYTES)  # registered as image/png
    r = complete(client, case, asset_id)
    assert r.status_code == 400, r.text
    assert "signature" in r.json()["error"]

    row = run(client, db.fetchrow, "SELECT * FROM assets WHERE asset_id=$1", asset_id)
    assert row["status"] == "failed"
    assert row["checksum"] is None


def test_wav_uploaded_as_webp_is_rejected(client, case):
    """End-to-end form of the RIFF-prefix bug: a WAV must not pass as a WebP."""
    asset_id = upload(client, case, WAV_BYTES, mime_type="image/webp", filename="a.webp")
    assert complete(client, case, asset_id).status_code == 400

    ok = upload(client, case, WEBP_BYTES, mime_type="image/webp", filename="b.webp")
    assert complete(client, case, ok).status_code == 200


# ---------------------------------------------------------------------------
# dedup
# ---------------------------------------------------------------------------


def test_duplicate_upload_is_detected_and_reuses_the_original(client, case):
    data = FIXTURE.read_bytes()
    first = upload(client, case, data, filename="one.png")
    second = upload(client, case, data, filename="two.png")

    a = complete(client, case, first).json()
    assert a["duplicate"] is False

    b = complete(client, case, second)
    assert b.status_code == 200, b.text
    body = b.json()
    assert body["duplicate"] is True
    assert body["original_asset_id"] == first
    assert body["status"] == "ready"
    assert body["checksum"] == a["checksum"]
    assert first in body["note"]

    rows = {
        r["asset_id"]: r
        for r in run(client, db.fetch,
                     "SELECT * FROM assets WHERE case_id=$1", case)
    }
    # No duplicate_of column exists, so the duplicate points at the original's
    # bytes instead - one object, two rows.
    assert rows[second]["storage_key_raw"] == rows[first]["storage_key_raw"]
    assert rows[second]["status"] == "ready"
    assert rows[second]["width"] == rows[first]["width"]


def test_different_files_are_not_duplicates(client, case):
    other = FIXTURE.parent / "opera-img2.png"
    first = upload(client, case, FIXTURE.read_bytes(), filename="one.png")
    second = upload(client, case, other.read_bytes(), filename="two.png")

    assert complete(client, case, first).json()["duplicate"] is False
    body = complete(client, case, second).json()
    assert body["duplicate"] is False
    assert body["status"] == "uploaded"


def test_an_asset_is_never_a_duplicate_of_itself(client, case):
    """The regression this module exists for.

    The old implementation's dedup query had no `AND asset_id <> $3`. Since the
    checksum is written to the row before the lookup, every asset matched
    itself, every upload looked like a duplicate, and the real thing was never
    caught. Both halves are asserted: the buggy SQL still self-matches, and
    check_duplicate does not.
    """
    data = FIXTURE.read_bytes()
    asset_id = upload(client, case, data)
    assert complete(client, case, asset_id).json()["duplicate"] is False

    checksum = hashlib.sha256(data).hexdigest()
    row = run(client, db.fetchrow, "SELECT * FROM assets WHERE asset_id=$1", asset_id)
    assert row["checksum"] == checksum and row["status"] == "uploaded"

    self_matched = run(
        client, db.fetchval,
        """SELECT asset_id FROM assets
            WHERE case_id=$1 AND checksum=$2 AND status IN ('uploaded','ready')
            ORDER BY created_at ASC LIMIT 1""",
        case, checksum,
    )
    assert self_matched == asset_id, "precondition: the unguarded query self-matches"

    assert run(client, validation.check_duplicate, case, checksum, asset_id) is None


def test_check_duplicate_ignores_other_cases(client, case):
    data = FIXTURE.read_bytes()
    asset_id = upload(client, case, data)
    assert complete(client, case, asset_id).status_code == 200
    checksum = hashlib.sha256(data).hexdigest()

    r = client.post("/api/cases", json={}, headers=AUTH)
    other_case = r.json()["case_id"]
    try:
        found = run(client, validation.check_duplicate,
                    other_case, checksum, "asset_whatever")
        assert found is None, "dedup must not leak bytes across cases"
    finally:
        run(client, db.execute, "DELETE FROM cases WHERE case_id=$1", other_case)


# ---------------------------------------------------------------------------
# list
# ---------------------------------------------------------------------------


def test_list_assets_returns_fresh_download_urls(client, case):
    data = FIXTURE.read_bytes()
    uploaded = upload(client, case, data)
    complete(client, case, uploaded)
    pending = register(client, case, filename="pending.png").json()["asset_id"]

    r = client.get(f"/api/cases/{case}/assets", headers=AUTH)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["count"] == 2
    by_id = {a["asset_id"]: a for a in body["assets"]}

    done = by_id[uploaded]
    assert done["status"] == "uploaded"
    assert done["checksum"] == hashlib.sha256(data).hexdigest()
    fetched = httpx.get(done["download_url"], timeout=60)
    assert fetched.status_code == 200 and fetched.content == data

    # Nothing has been PUT for this one yet, so there is nothing to sign.
    assert by_id[pending]["status"] == "awaiting_upload"
    assert by_id[pending]["download_url"] is None


def test_list_unknown_case_is_404(client):
    r = client.get(f"/api/cases/case_{uuid.uuid4().hex}/assets", headers=AUTH)
    assert r.status_code == 404
