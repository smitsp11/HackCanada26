import { NextRequest, NextResponse } from "next/server";
import pool from "@/lib/db";
import { verifyFileExists, downloadFile } from "@/lib/storage";
import { preprocessAsset } from "@/lib/preprocessing";
import { computeChecksum, checkDuplicate } from "@/lib/validation";
import { auditLog } from "@/lib/audit";
import { logger } from "@/lib/observability";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ caseId: string; assetId: string }> },
) {
  try {
    const { caseId, assetId } = await params;
    const ctx = { case_id: caseId, asset_id: assetId };

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

    // Deduplication: compute checksum early and check for duplicates
    if (storagePath) {
      try {
        const buffer = await downloadFile(storagePath);
        const checksum = computeChecksum(buffer);

        await pool.query(
          `UPDATE assets SET checksum_sha256 = $2 WHERE asset_id = $1`,
          [assetId, checksum],
        );

        const { isDuplicate, existingAssetId } = await checkDuplicate(caseId, checksum);

        if (isDuplicate && existingAssetId && existingAssetId !== assetId) {
          // Link to existing asset's derivatives instead of reprocessing
          const existing = await pool.query(
            `SELECT storage_uri_normalized, storage_uri_thumbnail
             FROM assets WHERE asset_id = $1`,
            [existingAssetId],
          );

          if (existing.rows.length > 0) {
            const { storage_uri_normalized, storage_uri_thumbnail } = existing.rows[0];
            await pool.query(
              `UPDATE assets
               SET duplicate_of = $2,
                   storage_uri_normalized = $3,
                   storage_uri_thumbnail = $4,
                   validation_status = 'validated',
                   processing_status = 'ready',
                   scan_status = 'clean'
               WHERE asset_id = $1`,
              [assetId, existingAssetId, storage_uri_normalized, storage_uri_thumbnail],
            );

            await auditLog("asset_duplicate_detected", ctx, {
              original_asset_id: existingAssetId, checksum,
            });
            logger.info("Duplicate detected, skipping preprocessing", ctx, {
              original_asset_id: existingAssetId,
            });

            await pool.query(
              `UPDATE cases SET status = 'validating', updated_at = NOW() WHERE case_id = $1`,
              [caseId],
            );

            return NextResponse.json({
              asset_id: assetId,
              status: "duplicate",
              original_asset_id: existingAssetId,
            });
          }
        }
      } catch (err) {
        // If dedup check fails, continue to normal preprocessing
        logger.warn("Deduplication check failed, continuing", ctx, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    await pool.query(
      `UPDATE cases SET status = 'validating', updated_at = NOW() WHERE case_id = $1`,
      [caseId],
    );

    await auditLog("asset_upload_completed", ctx);
    logger.metric({ event: "upload_completed" }, ctx);

    // Fire-and-forget async preprocessing
    if (storagePath) {
      preprocessAsset(caseId, assetId, asset.asset_type, storagePath).catch(
        (err) => logger.error(`Background preprocessing failed for ${assetId}`, ctx, {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }

    return NextResponse.json({
      asset_id: assetId,
      status: "processing",
    });
  } catch (error) {
    logger.error("POST /assets/complete failed", {}, {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: "Failed to complete asset upload" },
      { status: 500 },
    );
  }
}
