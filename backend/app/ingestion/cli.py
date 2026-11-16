"""Manual ingestion. Run offline, never in a request path.

    python -m app.ingestion.cli add manuals/opera-manual.pdf --brand Carrier

Does four things:
  1. Registers the PDF (hash, page count, upload to S3) so it has identity.
  2. Pulls the manufacturer's own service-scope statement into `scope_note`,
     which is what the safety gate cites when it routes a repair to a pro.
  3. Decodes the model nomenclature table into `appliances` rows, which is the
     catalog that identification validates against.
  4. Is idempotent on the PDF's sha256 - re-running costs nothing.

Only a handful of pages are sent to the model, not the whole manual.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import re
import sys
from pathlib import Path

from app.core import db, llm, manuals, pdf, storage
from app.ingestion import pages as pages_index

# Where the relevant tables tend to live. Front matter carries the safety
# scope; the nomenclature table is conventionally on the last page or two.
SAFETY_WINDOW = (1, 8)
NOMENCLATURE_TAIL = 3


SCOPE_SCHEMA = {
    "type": "object",
    "properties": {
        "scope_note": {
            "type": "string",
            "description": "Verbatim sentence(s) stating who may service this appliance.",
        },
        "pages": {"type": "array", "items": {"type": "integer"}},
        "appliance_type": {"type": "string"},
        "brand": {"type": "string"},
        "title": {"type": "string", "description": "The document title exactly as printed on the cover page."},
        "hazard_classes": {
            "type": "array",
            "items": {
                "type": "string",
                "enum": [
                    "gas",
                    "high_voltage",
                    "sealed_refrigerant",
                    "water_heater",
                    "combustion_venting",
                    "none",
                ],
            },
        },
    },
    "required": ["scope_note", "pages", "appliance_type", "brand", "hazard_classes", "title"],
    "additionalProperties": False,
}

NOMENCLATURE_SCHEMA = {
    "type": "object",
    "properties": {
        "series": {"type": "string"},
        "positions": {
            "type": "array",
            "description": "What each segment of the model number means, in order.",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "example": {"type": "string"},
                    "meaning": {"type": "string"},
                },
                "required": ["name", "example", "meaning"],
                "additionalProperties": False,
            },
        },
        "variants": {
            "type": "array",
            "description": "Every concrete unit/size variant listed anywhere in these pages.",
            "items": {
                "type": "object",
                "properties": {
                    "unit_number": {"type": "string"},
                    "btuh": {"type": "integer"},
                    "cabinet_width_in": {"type": "number"},
                    "cooling_cfm": {"type": "integer"},
                },
                "required": ["unit_number"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["series", "variants"],
    "additionalProperties": False,
}


def normalize_model(s: str) -> str:
    """Uppercase, strip punctuation. Plates, manuals and users all differ."""
    return re.sub(r"[^A-Z0-9]", "", (s or "").upper())


def slugify(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-")


async def ingest(path: Path, brand_hint: str | None, force: bool) -> None:
    data = path.read_bytes()
    sha = hashlib.sha256(data).hexdigest()
    pages = pdf.page_count(data)
    print(f"{path.name}: {pages} pages, {len(data)/1e6:.1f} MB, sha {sha[:12]}")

    existing = await db.fetchrow("SELECT manual_id FROM manuals WHERE pdf_sha256=$1", sha)
    if existing and not force:
        print(f"  already ingested as {existing['manual_id']} - nothing to do")
        return

    # --- 1. scope statement + identity, from the front matter only ---
    print("  reading service-scope statement...")
    front = pdf.page_window(data, *SAFETY_WINDOW)
    scope, u1 = await llm.llm.complete(
        [
            llm.pdf_part(front, "front-matter.pdf"),
            llm.text_part(
                "These are the opening pages of an appliance service manual.\n"
                "Find the statement that says who is permitted to service this "
                "appliance and what an untrained owner may do. Quote it verbatim "
                "in scope_note and give the page numbers it appears on, numbered "
                f"as pages {SAFETY_WINDOW[0]}-{SAFETY_WINDOW[1]} of the full manual.\n"
                "Also identify the brand, the appliance type, and which hazard "
                "classes this appliance involves."
            ),
        ],
        schema=SCOPE_SCHEMA,
        schema_name="manual_scope",
        max_tokens=2000,
    )
    brand = brand_hint or scope.get("brand") or "Unknown"
    title = scope.get("title") or path.stem
    print(f"    brand={brand} type={scope['appliance_type']} hazards={scope['hazard_classes']}")
    print(f"    scope: {scope['scope_note'][:110]}...")

    # --- 2. nomenclature -> catalog rows ---
    # The nomenclature table explains the *format* but usually only decodes one
    # example. The actual size list lives in the front-matter dimensions or
    # electrical-data table, so send both windows.
    print("  decoding model nomenclature...")
    spec_pages = list(range(1, SAFETY_WINDOW[1] + 1)) + list(
        range(max(1, pages - NOMENCLATURE_TAIL + 1), pages + 1)
    )
    spec = pdf.extract_pages(data, spec_pages)
    nomen, u2 = await llm.llm.complete(
        [
            llm.pdf_part(spec, "nomenclature.pdf"),
            llm.text_part(
                "These are the front-matter and final pages of an appliance "
                "service manual.\n"
                "The final pages carry a model nomenclature table explaining what "
                "each position of the model number means - describe those positions.\n"
                "The front matter usually carries a dimensions or specifications "
                "table enumerating every size the family is sold in. List EVERY "
                "size/unit variant you can find across these pages, using the "
                "exact unit designation as printed (for example '060M17--16'), "
                "with heating capacity in BTUh, cabinet width in inches, and "
                "nominal cooling airflow in CFM where derivable. Do not invent "
                "variants that are not printed."
            ),
        ],
        schema=NOMENCLATURE_SCHEMA,
        schema_name="model_nomenclature",
        max_tokens=4000,
    )
    series = nomen.get("series") or ""
    variants = nomen.get("variants") or []
    print(f"    series={series}  variants={len(variants)}")

    # --- 3. persist ---
    manual_id = slugify(f"{brand}-{series or path.stem}")
    storage_key = f"manuals/{manual_id}.pdf"
    print(f"  uploading to s3://{storage_key} ...")
    await storage.upload(storage_key, data, "application/pdf")

    await db.execute(
        """INSERT INTO manuals (manual_id, brand, title, pdf_path, pdf_sha256,
                                page_count, scope_note, scope_pages)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (manual_id) DO UPDATE SET
             brand=EXCLUDED.brand, title=EXCLUDED.title, pdf_path=EXCLUDED.pdf_path,
             pdf_sha256=EXCLUDED.pdf_sha256, page_count=EXCLUDED.page_count,
             scope_note=EXCLUDED.scope_note, scope_pages=EXCLUDED.scope_pages""",
        manual_id, brand, title, storage_key, sha, pages,
        scope["scope_note"], scope.get("pages") or [],
    )

    rows = 0
    for v in variants:
        unit = (v.get("unit_number") or "").strip()
        if not unit:
            continue
        attrs = {k: v[k] for k in ("btuh", "cabinet_width_in", "cooling_cfm") if v.get(k)}
        attrs["hazard_classes"] = scope["hazard_classes"]
        # Plates often print series+unit together (59SC6A060M17--16); store the
        # full form so an exact plate read matches without post-processing.
        full = unit if normalize_model(series) in normalize_model(unit) else f"{series}{unit}"
        await db.execute(
            """INSERT INTO appliances (brand, model_number, model_normalized, series,
                                       appliance_type, attributes, manual_id)
               VALUES ($1,$2,$3,$4,$5,$6,$7)
               ON CONFLICT (brand, model_normalized) DO UPDATE SET
                 attributes=EXCLUDED.attributes, manual_id=EXCLUDED.manual_id,
                 series=EXCLUDED.series, appliance_type=EXCLUDED.appliance_type""",
            brand, full, normalize_model(full), series,
            scope["appliance_type"], attrs, manual_id,
        )
        rows += 1

    # The bare series itself, so a partial plate read still resolves a manual.
    if series:
        await db.execute(
            """INSERT INTO appliances (brand, model_number, model_normalized, series,
                                       appliance_type, attributes, manual_id)
               VALUES ($1,$2,$3,$4,$5,$6,$7)
               ON CONFLICT (brand, model_normalized) DO UPDATE SET manual_id=EXCLUDED.manual_id""",
            brand, series, normalize_model(series), series,
            scope["appliance_type"], {"hazard_classes": scope["hazard_classes"]}, manual_id,
        )
        rows += 1

    print("  storing per-page text...")
    texts = await manuals.page_texts(data)
    print(f"    {len(texts)} pages -> s3://{manuals.text_key(manual_id)}")

    cost = (u1.get("cost") or 0) + (u2.get("cost") or 0)
    print(f"  done: manual_id={manual_id}, {rows} catalog rows, ingest cost ${cost:.4f}")


async def main() -> int:
    ap = argparse.ArgumentParser(prog="app.ingestion.cli")
    sub = ap.add_subparsers(dest="cmd", required=True)

    add = sub.add_parser("add", help="ingest a manual PDF")
    add.add_argument("path")
    add.add_argument("--brand", default=None)
    add.add_argument("--force", action="store_true", help="re-ingest even if the hash matches")

    sub.add_parser("list", help="show ingested manuals")

    tx = sub.add_parser("text", help="store per-page text for an already-ingested manual")
    tx.add_argument("manual_id")

    sub.add_parser("migrate", help="apply migrations/*.sql")

    idx = sub.add_parser("index", help="build the page-level retrieval index for an ingested manual")
    idx.add_argument("path")

    args = ap.parse_args()
    await db.init_pool()
    try:
        if args.cmd == "add":
            p = Path(args.path)
            if not p.exists():
                print(f"no such file: {p}", file=sys.stderr)
                return 1
            await ingest(p, args.brand, args.force)
        elif args.cmd == "text":
            texts = await manuals.page_texts(await manuals.pdf_bytes(args.manual_id))
            print(f"{args.manual_id}: {len(texts)} pages stored at s3://{manuals.text_key(args.manual_id)}")
        elif args.cmd == "migrate":
            await db.migrate()
            print("migrations applied")
        elif args.cmd == "index":
            data = Path(args.path).read_bytes()
            sha = hashlib.sha256(data).hexdigest()
            row = await db.fetchrow("SELECT manual_id, brand FROM manuals WHERE pdf_sha256=$1", sha)
            if not row:
                print(f"{args.path} is not ingested yet - run `add` first", file=sys.stderr)
                return 1
            print(f"indexing {row['manual_id']} ...")
            report = await pages_index.index_manual(row["manual_id"], data, row["brand"])
            print(json.dumps(report, indent=2))
        else:
            for r in await db.fetch(
                """SELECT m.manual_id, m.brand, m.page_count,
                          (SELECT count(*) FROM appliances a WHERE a.manual_id=m.manual_id) AS models
                     FROM manuals m ORDER BY m.created_at"""
            ):
                print(f"{r['manual_id']:28} {r['brand']:12} {r['page_count']:>4}pp  {r['models']} models")
    finally:
        await db.close_pool()
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
