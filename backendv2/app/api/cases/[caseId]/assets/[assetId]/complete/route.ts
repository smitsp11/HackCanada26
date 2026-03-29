import { NextRequest, NextResponse } from "next/server";
import pool from "@/lib/db";
import { verifyFileExists } from "@/lib/storage";
import { preprocessAsset } from "@/lib/preprocessing";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ caseId: string; assetId: string }> },
) {
  try {
    const { caseId, assetId } = await params;

    const assetResult = await pool.query(
      `SELECT asset_id, case_id, asset_type, storage_uri_raw, upload_status
       FROM assets WHERE asset_id = $1 AND case_id = $2`,
      [assetId, caseId],
    );

    if (assetResult.rows.length === 0) {
      return NextResponse.json(
        { error: "Asset not found for this case" },
        { status: 404 },
      );
    }

    const asset = assetResult.rows[0];

    if (asset.upload_status === "uploaded") {
      return NextResponse.json({
        asset_id: assetId,
        status: "already_uploaded",
      });
    }

    const storagePath = asset.storage_uri_raw;
    if (storagePath) {
      const exists = await verifyFileExists(storagePath);
      if (!exists) {
        return NextResponse.json(
          { error: "File not found in storage. Upload may not have completed." },
          { status: 400 },
        );
      }
    }

    await pool.query(
      `UPDATE assets SET upload_status = 'uploaded' WHERE asset_id = $1`,
      [assetId],
    );

    await pool.query(
      `UPDATE cases SET status = 'validating', updated_at = NOW() WHERE case_id = $1`,
      [caseId],
    );

    // Fire-and-forget async preprocessing
    if (storagePath) {
      preprocessAsset(caseId, assetId, asset.asset_type, storagePath).catch(
        (err) => console.error(`Background preprocessing failed for ${assetId}:`, err),
      );
    }

    return NextResponse.json({
      asset_id: assetId,
      status: "processing",
    });
  } catch (error) {
    console.error("POST /assets/complete failed:", error);
    return NextResponse.json(
      { error: "Failed to complete asset upload" },
      { status: 500 },
    );
  }
}
