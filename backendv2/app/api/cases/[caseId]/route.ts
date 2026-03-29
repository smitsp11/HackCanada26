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
      `SELECT asset_id, asset_type, slot_key, mime_type, size_bytes,
              cloudinary_public_id, cloudinary_url,
              validation_status, processing_status, created_at
       FROM assets WHERE case_id = $1
       ORDER BY created_at`,
      [caseId],
    );

    const caseRow = caseResult.rows[0];
    return NextResponse.json({
      ...caseRow,
      assets: assetsResult.rows,
    });
  } catch (error) {
    console.error("GET /api/cases/[caseId] failed:", error);
    return NextResponse.json(
      { error: "Failed to fetch case" },
      { status: 500 },
    );
  }
}
