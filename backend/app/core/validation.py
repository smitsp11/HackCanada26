"""Upload validation: what we accept, and proof we got what was declared.

A client-declared MIME type is a hint, not evidence. Everything here that can
be checked against real bytes is checked against real bytes, because the whole
point of the presigned path is that the browser writes to S3 without this
process ever seeing the payload on the way in. The only moment we can tell a
PNG from a renamed executable is at `complete`.

Errors are raised as `ValidationError`, which carries the HTTP status the API
layer should surface. Keeping FastAPI out of this module means the rules stay
callable from the pipeline and from scripts.
"""

from __future__ import annotations

import hashlib
from typing import Optional, Union

from app.config import settings
from app.core import db
from app.schemas.contracts import AssetRole

# --------------------------------------------------------------------------
# Allowlist
# --------------------------------------------------------------------------

IMAGE_MIMES = frozenset(
    {
        "image/jpeg",
        "image/png",
        "image/webp",
        "image/heic",
        "image/heif",
    }
)

VIDEO_MIMES = frozenset(
    {
        "video/mp4",
        "video/quicktime",
        "video/webm",
    }
)

ALLOWED_MIMES = IMAGE_MIMES | VIDEO_MIMES


class ValidationError(Exception):
    """A rejected upload, with the status code the API should answer with."""

    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def normalize_mime(mime: Optional[str]) -> str:
    """`image/JPEG; charset=binary` -> `image/jpeg`."""
    return (mime or "").split(";")[0].strip().lower()


def _as_role(role: Union[AssetRole, str, None]) -> AssetRole:
    if isinstance(role, AssetRole):
        return role
    try:
        return AssetRole(str(role).lower())
    except ValueError:
        return AssetRole.OTHER


def is_allowed_mime(mime: Optional[str], role: Union[AssetRole, str, None]) -> bool:
    """Role decides the family: only the `video` role may carry video.

    Otherwise a video uploaded as `other` would be size-checked against the
    image limit, which is ten times smaller than the one it should get.
    """
    mime = normalize_mime(mime)
    if _as_role(role) is AssetRole.VIDEO:
        return mime in VIDEO_MIMES
    return mime in IMAGE_MIMES


# --------------------------------------------------------------------------
# File signatures
# --------------------------------------------------------------------------

# heic/heif/mp4/mov all wrap their payload in an ISO base media `ftyp` box, so
# the major brand at offset 8 is the only thing separating them.
_FTYP_BRANDS: dict[str, frozenset[str]] = {
    "image/heic": frozenset({"heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1"}),
    "image/heif": frozenset({"heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1"}),
    "video/mp4": frozenset({"isom", "iso2", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "dash", "mmp4", "m4v ", "3gp4", "3gp5", "3g2a"}),
    "video/quicktime": frozenset({"qt  "}),
}

# Some .mov files open with a bare top-level atom instead of an ftyp box.
_QUICKTIME_ATOMS = frozenset({b"moov", b"mdat", b"wide", b"free", b"skip", b"pnot"})


def check_magic_bytes(data: bytes, declared_mime: Optional[str]) -> bool:
    """True when the real file signature matches what the client declared."""
    mime = normalize_mime(declared_mime)
    if not data or len(data) < 12 or mime not in ALLOWED_MIMES:
        return False

    if mime == "image/jpeg":
        return data[:3] == b"\xff\xd8\xff"

    if mime == "image/png":
        return data[:8] == b"\x89PNG\r\n\x1a\n"

    if mime == "image/webp":
        # RIFF alone is also WAV and AVI. The fourCC at offset 8 is the only
        # thing that makes a RIFF container a WebP, so both must match.
        return data[:4] == b"RIFF" and data[8:12] == b"WEBP"

    if mime == "video/webm":
        return data[:4] == b"\x1a\x45\xdf\xa3"  # EBML

    brands = _FTYP_BRANDS.get(mime)
    if brands is not None:
        if data[4:8] == b"ftyp":
            brand = data[8:12].decode("latin-1").lower()
            if brand in brands:
                return True
            # Unregistered mp4 brands are common; the family prefix is enough.
            return mime == "video/mp4" and brand[:3] in ("iso", "mp4", "3gp", "avc")
        return mime == "video/quicktime" and data[4:8] in _QUICKTIME_ATOMS

    return False


def compute_checksum(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# --------------------------------------------------------------------------
# Limits
# --------------------------------------------------------------------------


def limit_for(role: Union[AssetRole, str, None]) -> int:
    return (
        settings.max_video_bytes
        if _as_role(role) is AssetRole.VIDEO
        else settings.max_image_bytes
    )


def validate_size(size_bytes: Optional[int], role: Union[AssetRole, str, None]) -> None:
    """Raises ValidationError(413) when the file is over the role's limit."""
    if size_bytes is None:
        return
    if size_bytes <= 0:
        raise ValidationError(400, "size_bytes must be a positive integer")
    limit = limit_for(role)
    if size_bytes > limit:
        raise ValidationError(
            413, f"{size_bytes} bytes exceeds the {limit} byte limit for role "
                 f"'{_as_role(role).value}'"
        )


async def check_quota(case_id: str) -> int:
    """Raises ValidationError(429) once a case holds max_assets_per_case assets."""
    count = await db.fetchval(
        "SELECT count(*) FROM assets WHERE case_id=$1 AND status <> 'failed'",
        case_id,
    )
    count = int(count or 0)
    if count >= settings.max_assets_per_case:
        raise ValidationError(
            429,
            f"case already holds {count} assets "
            f"(limit {settings.max_assets_per_case})",
        )
    return count


# --------------------------------------------------------------------------
# Deduplication
# --------------------------------------------------------------------------


async def check_duplicate(
    case_id: str, checksum: str, exclude_asset_id: str
) -> Optional[str]:
    """The earlier asset in this case holding the same bytes, if any.

    `AND asset_id <> $3` is load-bearing. The caller has already written this
    asset's own checksum to the row before asking, so without the exclusion the
    query matches the asset against itself, every upload looks like a duplicate
    of itself, and dedup silently does nothing. That was the bug in the previous
    implementation; tests/test_assets.py pins it.
    """
    if not checksum:
        return None
    return await db.fetchval(
        """SELECT asset_id FROM assets
            WHERE case_id = $1
              AND checksum = $2
              AND asset_id <> $3
              AND status IN ('uploaded', 'ready')
            ORDER BY created_at ASC
            LIMIT 1""",
        case_id,
        checksum,
        exclude_asset_id,
    )
