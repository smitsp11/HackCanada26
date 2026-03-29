import { NextRequest, NextResponse } from "next/server";
import pool from "@/lib/db";
import { createSignedUploadUrl } from "@/lib/storage";
import { isAllowedMime, validateSizeLimits } from "@/lib/validation";
import { auditLog } from "@/lib/audit";
import { logger } from "@/lib/observability";
import { checkUploadQuota } from "@/lib/quota";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ caseId: string }> },
) {
  const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  try {
    const { caseId } = await params;
    const ctx = { case_id: caseId, request_id: requestId };

    const caseResult = await pool.query(
      `SELECT case_id, status, user_id FROM cases WHERE case_id = $1`,
      [caseId],
    );

    if (caseResult.rows.length === 0) {
      return NextResponse.json({ error: "Case not found" }, { status: 404 });
    }

    const caseRow = caseResult.rows[0];
    const caseStatus = caseRow.status;
    const userId = caseRow.user_id;
    const uploadableStatuses = ["created", "awaiting_upload", "ingestion_in_progress"];
    if (!uploadableStatuses.includes(caseStatus)) {
      return NextResponse.json(
        { error: `Case status '${caseStatus}' does not allow new uploads` },
        { status: 409 },
      );
    }

    const body = await req.json();
    const { filename, mime_type, asset_type, size_bytes, slot_key } = body;

    if (!filename || !mime_type || !asset_type) {
      return NextResponse.json(
        { error: "Missing required fields: filename, mime_type, asset_type" },
        { status: 400 },
      );
    }

    if (!isAllowedMime(mime_type, asset_type)) {
      return NextResponse.json(
        { error: `MIME type '${mime_type}' not allowed for asset_type '${asset_type}'` },
        { status: 400 },
      );
    }

    if (size_bytes) {
      const { valid, limit } = validateSizeLimits(size_bytes, asset_type);
      if (!valid) {
        return NextResponse.json(
          { error: `File size ${size_bytes} exceeds limit of ${limit} bytes for ${asset_type}` },
          { status: 413 },
        );
      }
    }

    // Quota check
    const quota = await checkUploadQuota(caseId, userId);
    if (!quota.allowed) {
      await auditLog("quota_exceeded", { ...ctx, user_id: userId }, { reason: quota.reason });
      logger.warn("Quota exceeded", { ...ctx, user_id: userId }, { reason: quota.reason });
      return NextResponse.json(
        { error: quota.reason },
        { status: 429 },
      );
    }

    const assetId = `asset_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const { uploadUrl, storagePath, expiresAt } = await createSignedUploadUrl(
      caseId,
      assetId,
      filename,
    );

    await pool.query(
      `INSERT INTO assets
       (asset_id, case_id, asset_type, slot_key, mime_type, size_bytes,
        original_filename, storage_uri_raw, upload_status, validation_status, processing_status, scan_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'awaiting_upload', 'pending', 'pending', 'pending')`,
      [assetId, caseId, asset_type, slot_key ?? null, mime_type, size_bytes ?? null, filename, storagePath],
    );

    await pool.query(
      `UPDATE cases SET status = 'awaiting_upload', updated_at = NOW()
       WHERE case_id = $1 AND status = 'created'`,
      [caseId],
    );

    await auditLog("asset_registered", { ...ctx, asset_id: assetId }, {
      filename, mime_type, asset_type, size_bytes, slot_key,
    });
    logger.metric({
      event: "upload_registered",
      file_size_bytes: size_bytes,
      mime_type,
    }, { ...ctx, asset_id: assetId });

    return NextResponse.json(
      {
        asset_id: assetId,
        upload_url: uploadUrl,
        storage_path: storagePath,
        expires_at: expiresAt,
      },
      { status: 201 },
    );
  } catch (error) {
    logger.error("POST /assets/register failed", { request_id: requestId }, {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: "Failed to register asset" },
      { status: 500 },
    );
  }
}
