"""
Exports labeled training data from Postgres for model training and calibration.

Usage:
    python scripts/export_training_data.py --output-dir ./data --db-url "postgresql://..."

Exports:
    - observations.csv: raw observations with optional verified labels
    - candidates.csv: identity candidates with optional verified labels
    - cases.csv: case understanding outputs with labels
    - calibration_pairs.csv: (source_type, field, raw_confidence, is_correct) for calibration
    - images_manifest.csv: asset_id, storage_uri, labels for CV training
"""

import argparse
import csv
import json
import os
import sys
from pathlib import Path

import psycopg2
import psycopg2.extras


def connect(db_url: str):
    return psycopg2.connect(db_url, cursor_factory=psycopg2.extras.RealDictCursor)


def export_observations(conn, output_dir: Path):
    with conn.cursor() as cur:
        cur.execute("""
            SELECT
                o.observation_id, o.case_id, o.asset_id, o.source_type,
                o.field, o.value, o.confidence, o.region_type, o.metadata,
                tl.verified_value, tl.labeler
            FROM observations o
            LEFT JOIN training_labels tl
                ON tl.case_id = o.case_id AND tl.field = o.field
            ORDER BY o.case_id, o.observation_id
        """)
        rows = cur.fetchall()

    path = output_dir / "observations.csv"
    if not rows:
        print("No observations found")
        return

    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=rows[0].keys())
        writer.writeheader()
        for row in rows:
            if row.get("metadata") and not isinstance(row["metadata"], str):
                row["metadata"] = json.dumps(row["metadata"])
            writer.writerow(row)
    print(f"Exported {len(rows)} observations to {path}")


def export_candidates(conn, output_dir: Path):
    with conn.cursor() as cur:
        cur.execute("""
            SELECT
                ic.candidate_id, ic.case_id, ic.candidate_type, ic.value,
                ic.rank, ic.confidence, ic.supporting_obs_ids,
                tl.verified_value, tl.labeler
            FROM identity_candidates ic
            LEFT JOIN training_labels tl
                ON tl.case_id = ic.case_id AND tl.field = ic.candidate_type
            ORDER BY ic.case_id, ic.rank
        """)
        rows = cur.fetchall()

    path = output_dir / "candidates.csv"
    if not rows:
        print("No candidates found")
        return

    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=rows[0].keys())
        writer.writeheader()
        for row in rows:
            if isinstance(row.get("supporting_obs_ids"), list):
                row["supporting_obs_ids"] = json.dumps(row["supporting_obs_ids"])
            writer.writerow(row)
    print(f"Exported {len(rows)} candidates to {path}")


def export_cases(conn, output_dir: Path):
    with conn.cursor() as cur:
        cur.execute("""
            SELECT
                cu.understanding_id, cu.case_id,
                cu.appliance_type_json, cu.brand_candidates_json,
                cu.model_candidates_json, cu.error_codes_json,
                cu.symptoms_json, cu.fallback_status_json,
                cu.resolved_identity_level, cu.created_at
            FROM case_understanding cu
            ORDER BY cu.created_at
        """)
        rows = cur.fetchall()

    path = output_dir / "cases.csv"
    if not rows:
        print("No case understanding records found")
        return

    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=rows[0].keys())
        writer.writeheader()
        for row in rows:
            for key in row:
                if key.endswith("_json") and row[key] and not isinstance(row[key], str):
                    row[key] = json.dumps(row[key])
            writer.writerow(row)
    print(f"Exported {len(rows)} case understanding records to {path}")


def export_calibration_pairs(conn, output_dir: Path):
    """Builds (source_type, field, raw_confidence, is_correct) pairs for calibration."""
    with conn.cursor() as cur:
        cur.execute("""
            SELECT
                o.source_type, o.field, o.confidence AS raw_confidence,
                o.value, tl.verified_value,
                CASE WHEN LOWER(TRIM(o.value)) = LOWER(TRIM(tl.verified_value))
                     THEN 1 ELSE 0 END AS is_correct
            FROM observations o
            INNER JOIN training_labels tl
                ON tl.case_id = o.case_id AND tl.field = o.field
            WHERE o.field NOT IN ('raw_ocr_text')
            ORDER BY o.source_type, o.field
        """)
        rows = cur.fetchall()

    path = output_dir / "calibration_pairs.csv"
    if not rows:
        print("No labeled calibration pairs found")
        return

    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=rows[0].keys())
        writer.writeheader()
        writer.writerows(rows)
    print(f"Exported {len(rows)} calibration pairs to {path}")


def export_images_manifest(conn, output_dir: Path):
    """Exports image asset info with labels for CV model training."""
    with conn.cursor() as cur:
        cur.execute("""
            SELECT
                a.asset_id, a.case_id, a.asset_type, a.slot_key,
                a.storage_uri_normalized, a.cloudinary_url,
                tl_type.verified_value AS appliance_type_label,
                tl_brand.verified_value AS brand_label,
                tl_model.verified_value AS model_label
            FROM assets a
            LEFT JOIN training_labels tl_type
                ON tl_type.case_id = a.case_id AND tl_type.field = 'appliance_type'
            LEFT JOIN training_labels tl_brand
                ON tl_brand.case_id = a.case_id AND tl_brand.field = 'brand'
            LEFT JOIN training_labels tl_model
                ON tl_model.case_id = a.case_id AND tl_model.field = 'model'
            WHERE a.asset_type = 'image'
                AND a.duplicate_of IS NULL
            ORDER BY a.case_id
        """)
        rows = cur.fetchall()

    path = output_dir / "images_manifest.csv"
    if not rows:
        print("No image assets found")
        return

    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=rows[0].keys())
        writer.writeheader()
        writer.writerows(rows)
    print(f"Exported {len(rows)} image records to {path}")


def main():
    parser = argparse.ArgumentParser(description="Export training data from Postgres")
    parser.add_argument("--output-dir", default="./data", help="Output directory for CSVs")
    parser.add_argument("--db-url", default=os.environ.get("DATABASE_URL", ""),
                        help="Postgres connection string (or set DATABASE_URL)")
    args = parser.parse_args()

    if not args.db_url:
        print("Error: --db-url or DATABASE_URL env var required", file=sys.stderr)
        sys.exit(1)

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    conn = connect(args.db_url)
    try:
        export_observations(conn, output_dir)
        export_candidates(conn, output_dir)
        export_cases(conn, output_dir)
        export_calibration_pairs(conn, output_dir)
        export_images_manifest(conn, output_dir)
    finally:
        conn.close()

    print(f"\nAll exports written to {output_dir}")


if __name__ == "__main__":
    main()
