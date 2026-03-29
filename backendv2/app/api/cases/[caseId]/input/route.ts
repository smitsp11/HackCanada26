import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import pool from "@/lib/db";

interface AssetInput {
  cloudinary_url: string;
  cloudinary_public_id?: string;
  slot_key: string;
  asset_type: string;
  mime_type?: string;
  size_bytes?: number;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ caseId: string }> },
) {
  try {
    const { caseId } = await params;
    const body = await req.json();

    const description: string | undefined = body?.description;
    const metadata: Record<string, unknown> | undefined = body?.metadata;
    const assetsInput: AssetInput[] | undefined = body?.assets;

    const caseCheck = await pool.query(
      `SELECT case_id FROM cases WHERE case_id = $1`,
      [caseId],
    );
    if (caseCheck.rows.length === 0) {
      return NextResponse.json({ error: "Case not found" }, { status: 404 });
    }

    const assetIds: string[] = [];

    if (assetsInput && Array.isArray(assetsInput)) {
      for (const asset of assetsInput) {
        if (!asset.cloudinary_url || !asset.slot_key || !asset.asset_type) {
          continue;
        }

        const assetId = `asset_${crypto.randomUUID()}`;
        assetIds.push(assetId);

        await pool.query(
          `INSERT INTO assets (asset_id, case_id, asset_type, slot_key, mime_type,
                               size_bytes, cloudinary_public_id, cloudinary_url)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            assetId,
            caseId,
            asset.asset_type,
            asset.slot_key,
            asset.mime_type ?? null,
            asset.size_bytes ?? null,
            asset.cloudinary_public_id ?? null,
            asset.cloudinary_url,
          ],
        );
      }
    }

    await pool.query(
      `UPDATE cases
       SET description_raw = COALESCE($2, description_raw),
           metadata = COALESCE($3, metadata),
           status = 'ingestion_in_progress',
           updated_at = NOW()
       WHERE case_id = $1`,
      [caseId, description ?? null, metadata ? JSON.stringify(metadata) : null],
    );

    return NextResponse.json({
      case_id: caseId,
      asset_ids: assetIds,
      status: "ingestion_in_progress",
    });
  } catch (error) {
    console.error("POST /api/cases/[caseId]/input failed:", error);
    return NextResponse.json(
      { error: "Failed to submit case input" },
      { status: 500 },
    );
  }
}
