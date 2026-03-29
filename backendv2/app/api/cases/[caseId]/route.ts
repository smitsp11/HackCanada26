import { NextRequest, NextResponse } from "next/server";
import pool from "@/lib/db";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ caseId: string }> },
) {
  try {
    const { caseId } = await params;

    const caseResult = await pool.query(
      `SELECT case_id, user_id, status, appliance_type_hint,
              description_raw, metadata, created_at, updated_at
       FROM cases WHERE case_id = $1`,
      [caseId],
    );

    if (caseResult.rows.length === 0) {
      return NextResponse.json({ error: "Case not found" }, { status: 404 });
    }

    const assetsResult = await pool.query(
      `SELECT a.asset_id, a.asset_type, a.slot_key, a.mime_type, a.size_bytes,
              a.original_filename, a.cloudinary_public_id, a.cloudinary_url,
              a.storage_uri_raw, a.storage_uri_normalized, a.storage_uri_thumbnail,
              a.upload_status, a.validation_status, a.processing_status,
              a.checksum_sha256, a.created_at,
              m.width, m.height, m.duration_sec, m.codec, m.orientation
       FROM assets a
       LEFT JOIN asset_metadata m ON a.asset_id = m.asset_id
       WHERE a.case_id = $1
       ORDER BY a.created_at`,
      [caseId],
    );

    const jobsResult = await pool.query(
      `SELECT job_id, asset_id, job_type, status, error_code, error_message,
              retry_count, created_at, completed_at
       FROM jobs WHERE case_id = $1
       ORDER BY created_at`,
      [caseId],
    );

    const caseRow = caseResult.rows[0];
    return NextResponse.json({
      ...caseRow,
      assets: assetsResult.rows,
      jobs: jobsResult.rows,
    });
  } catch (error) {
    console.error("GET /api/cases/[caseId] failed:", error);
    return NextResponse.json(
      { error: "Failed to fetch case" },
      { status: 500 },
    );
  }
}
