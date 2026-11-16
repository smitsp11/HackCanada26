"""End-to-end smoke test for the three external dependencies.

Run it after changing credentials or before building on top of the plumbing:

    ./.venv/bin/python -m tests.smoke

Proves, with real calls and no mocks:
  1. S3   - presigned PUT upload, presigned GET download, byte-for-byte match
  2. DB   - insert a case + asset + stage_run, read them back, clean up
  3. LLM  - image input through OpenRouter to Gemini with a JSON schema out

Costs a fraction of a cent for the one model call.
"""

from __future__ import annotations

import asyncio
import io
import json
import time
import uuid

import httpx

from app.config import settings
from app.core import db, llm, storage

PASS, FAIL = "  PASS", "  FAIL"


def _nameplate_png() -> bytes:
    """Synthetic nameplate so the test is repeatable without a real photo."""
    from PIL import Image, ImageDraw, ImageFont

    font = None
    for path in (
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
    ):
        try:
            font = ImageFont.truetype(path, 34)
            break
        except Exception:
            continue
    font = font or ImageFont.load_default()

    img = Image.new("RGB", (900, 420), "white")
    d = ImageDraw.Draw(img)
    d.rectangle([20, 20, 880, 400], outline="black", width=4)
    for i, line in enumerate(
        [
            "Carrier  Comfort 96",
            "Condensing Gas Furnace",
            "Model Number: 59SC6A",
            "Unit Number: 59SC6A060M17--16",
            "Serial Number: 2417C12345",
            "115V - 60Hz - 1 Phase    AFUE: 96%",
        ]
    ):
        d.text((55, 55 + i * 55), line, font=font, fill="black")

    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


async def check_s3() -> bool:
    print("\n[1/3] S3 round trip")
    key = f"raw/_smoke/{uuid.uuid4().hex}/hello.txt"
    payload = f"opera-ai smoke {time.time()}".encode()

    try:
        url, expires = await storage.create_signed_upload_url(key, "text/plain")
        async with httpx.AsyncClient(timeout=60) as c:
            put = await c.put(url, content=payload, headers={"Content-Type": "text/plain"})
        if put.status_code not in (200, 204):
            print(FAIL, f"presigned PUT returned {put.status_code}: {put.text[:200]}")
            return False
        print(PASS, f"presigned PUT ok (expires {expires:%H:%M:%S}Z)")

        if not await storage.exists(key):
            print(FAIL, "object not found after upload")
            return False
        print(PASS, "object exists")

        get_url = await storage.create_signed_download_url(key)
        async with httpx.AsyncClient(timeout=60) as c:
            got = await c.get(get_url)
        if got.content != payload:
            print(FAIL, "downloaded bytes differ from uploaded")
            return False
        print(PASS, "presigned GET returned identical bytes")
        return True
    except Exception as e:
        print(FAIL, f"{type(e).__name__}: {e}")
        return False


async def check_db() -> bool:
    print("\n[2/3] Postgres write/read")
    case_id = f"case_smoke_{uuid.uuid4().hex[:8]}"
    try:
        await db.execute(
            "INSERT INTO cases (case_id, status, symptom) VALUES ($1,$2,$3)",
            case_id,
            "created",
            "smoke test: furnace will not ignite",
        )
        await db.execute(
            """INSERT INTO assets (asset_id, case_id, role, mime_type, status)
               VALUES ($1,$2,$3,$4,$5)""",
            f"asset_{uuid.uuid4().hex[:8]}",
            case_id,
            "nameplate",
            "image/png",
            "uploaded",
        )
        # JSONB round trip - the codec in core/db.py should hand back a dict.
        await db.execute(
            """INSERT INTO stage_runs (stage_run_id, case_id, stage, status, output)
               VALUES ($1,$2,$3,$4,$5)""",
            f"sr_{uuid.uuid4().hex[:8]}",
            case_id,
            "identify",
            "done",
            # Bind a dict, not a pre-dumped string - core/db.py handles both,
            # but the dict form is the one stages should use.
            {"brand": "Carrier", "model_number": "59SC6A"},
        )

        row = await db.fetchrow(
            """SELECT c.symptom,
                      (SELECT count(*) FROM assets a WHERE a.case_id=c.case_id) AS assets,
                      (SELECT output FROM stage_runs s
                        WHERE s.case_id=c.case_id AND s.stage='identify') AS identity
                 FROM cases c WHERE c.case_id=$1""",
            case_id,
        )
        if not row or row["assets"] != 1:
            print(FAIL, "rows did not read back")
            return False
        if not isinstance(row["identity"], dict):
            print(FAIL, f"JSONB came back as {type(row['identity']).__name__}, expected dict")
            return False
        print(PASS, f"case + asset + stage_run persisted; JSONB -> {row['identity']}")

        # ON DELETE CASCADE should take the children with it.
        await db.execute("DELETE FROM cases WHERE case_id=$1", case_id)
        left = await db.fetchval("SELECT count(*) FROM assets WHERE case_id=$1", case_id)
        if left:
            print(FAIL, "cascade delete left orphaned assets")
            return False
        print(PASS, "cascade delete cleaned up")
        return True
    except Exception as e:
        print(FAIL, f"{type(e).__name__}: {e}")
        try:
            await db.execute("DELETE FROM cases WHERE case_id=$1", case_id)
        except Exception:
            pass
        return False


IDENTITY_SCHEMA = {
    "type": "object",
    "properties": {
        "brand": {"type": "string"},
        "model_number": {"type": "string"},
        "unit_number": {"type": "string"},
        "serial": {"type": "string"},
        "appliance_type": {"type": "string"},
        "confidence": {"type": "number"},
    },
    "required": ["brand", "model_number", "appliance_type", "confidence"],
    "additionalProperties": False,
}


async def check_llm() -> bool:
    print("\n[3/3] Gemini via OpenRouter (vision + JSON schema)")
    try:
        parts = [
            llm.image_part(_nameplate_png(), "image/png"),
            llm.text_part(
                "This is an appliance data plate. Extract the fields. "
                "Return only what is printed; leave a field out if it is absent."
            ),
        ]
        data, usage = await llm.llm.complete(
            parts,
            system="You read appliance nameplates and return structured data.",
            schema=IDENTITY_SCHEMA,
            schema_name="appliance_identity",
            max_tokens=500,
        )
        print(PASS, f"parsed -> {json.dumps(data)}")
        print(
            "      ",
            f"model={usage.get('model')} tokens={usage.get('total_tokens')} "
            f"cost=${usage.get('cost', 0):.5f}",
        )

        expected = {"brand": "carrier", "model_number": "59sc6a"}
        for field, want in expected.items():
            got = str(data.get(field, "")).lower()
            if want not in got:
                print(FAIL, f"{field}: expected to contain {want!r}, got {got!r}")
                return False
        print(PASS, "brand and model number read correctly off the plate")
        return True
    except Exception as e:
        print(FAIL, f"{type(e).__name__}: {e}")
        return False


async def main() -> int:
    print("Opera AI smoke test")
    print(f"  bucket   {settings.s3_bucket} ({settings.aws_region})")
    print(f"  model    {settings.model_default}")

    await db.init_pool()
    try:
        results = [await check_s3(), await check_db(), await check_llm()]
    finally:
        await db.close_pool()

    ok = sum(results)
    print(f"\n{'=' * 44}\n{ok}/3 passed")
    return 0 if ok == 3 else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
