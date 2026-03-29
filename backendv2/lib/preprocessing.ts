import sharp from "sharp";
import pool from "./db";
import { downloadFile, uploadDerived } from "./storage";
import { computeChecksum, validateMagicBytes } from "./validation";
import { createJob, updateJobStatus } from "./jobs";

const THUMBNAIL_SIZE = 256;
const NORMALIZED_MAX_WIDTH = 1920;

export async function preprocessAsset(
  caseId: string,
  assetId: string,
  assetType: string,
  storagePath: string,
): Promise<void> {
  const jobId = await createJob(caseId, assetId, "media_preprocessing");

  try {
    await updateJobStatus(jobId, "processing");

    await pool.query(
      `UPDATE assets SET validation_status = 'validating', processing_status = 'processing' WHERE asset_id = $1`,
      [assetId],
    );

    const buffer = await downloadFile(storagePath);

    const checksum = computeChecksum(buffer);
    await pool.query(
      `UPDATE assets SET checksum_sha256 = $2 WHERE asset_id = $1`,
      [assetId, checksum],
    );

    if (assetType === "image") {
      await preprocessImage(caseId, assetId, buffer, storagePath);
    } else if (assetType === "video") {
      await preprocessVideo(caseId, assetId, buffer);
    }

    await pool.query(
      `UPDATE assets SET validation_status = 'validated', processing_status = 'ready' WHERE asset_id = $1`,
      [assetId],
    );

    await updateJobStatus(jobId, "completed", { checksum });

    await updateCaseStatusIfReady(caseId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`Preprocessing failed for asset ${assetId}:`, message);

    await pool.query(
      `UPDATE assets SET validation_status = 'failed', processing_status = 'failed' WHERE asset_id = $1`,
      [assetId],
    );
    await updateJobStatus(jobId, "failed", null, message, "ERR_PREPROCESSING_FAILED");

    await updateCaseStatusIfReady(caseId);
  }
}

async function preprocessImage(
  caseId: string,
  assetId: string,
  buffer: Buffer,
  rawPath: string,
): Promise<void> {
  const image = sharp(buffer);
  const metadata = await image.metadata();

  const { valid } = validateMagicBytes(buffer, `image/${metadata.format}`);
  if (!valid && metadata.format) {
    console.warn(`Magic byte mismatch for asset ${assetId}, format: ${metadata.format}`);
  }

  await pool.query(
    `INSERT INTO asset_metadata (asset_id, width, height, orientation, exif_json)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (asset_id) DO UPDATE
     SET width = $2, height = $3, orientation = $4, exif_json = $5`,
    [
      assetId,
      metadata.width ?? null,
      metadata.height ?? null,
      metadata.orientation ?? null,
      metadata.exif ? JSON.stringify({ size: metadata.exif.length }) : null,
    ],
  );

  const normalizedBuffer = await sharp(buffer)
    .rotate()
    .resize({ width: NORMALIZED_MAX_WIDTH, withoutEnlargement: true })
    .withMetadata({ orientation: undefined })
    .jpeg({ quality: 85 })
    .toBuffer();

  const normalizedPath = rawPath.replace("raw/", "normalized/").replace(/\.[^.]+$/, ".jpg");
  await uploadDerived(normalizedPath, normalizedBuffer, "image/jpeg");

  const thumbnailBuffer = await sharp(buffer)
    .rotate()
    .resize({ width: THUMBNAIL_SIZE, height: THUMBNAIL_SIZE, fit: "cover" })
    .jpeg({ quality: 70 })
    .toBuffer();

  const thumbPath = rawPath.replace("raw/", "thumbs/").replace(/\.[^.]+$/, "_thumb.jpg");
  await uploadDerived(thumbPath, thumbnailBuffer, "image/jpeg");

  await pool.query(
    `UPDATE assets SET storage_uri_normalized = $2, storage_uri_thumbnail = $3 WHERE asset_id = $1`,
    [assetId, normalizedPath, thumbPath],
  );
}

async function preprocessVideo(
  caseId: string,
  assetId: string,
  buffer: Buffer,
): Promise<void> {
  // Basic video metadata extraction without ffprobe
  // Store what we can infer from the buffer header
  const size = buffer.length;

  await pool.query(
    `INSERT INTO asset_metadata (asset_id, derived_metadata_json)
     VALUES ($1, $2)
     ON CONFLICT (asset_id) DO UPDATE SET derived_metadata_json = $2`,
    [assetId, JSON.stringify({ size_bytes: size, note: "Full video preprocessing requires ffmpeg (Phase C)" })],
  );
}

async function updateCaseStatusIfReady(caseId: string): Promise<void> {
  const result = await pool.query(
    `SELECT
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE processing_status IN ('ready', 'failed')) AS done,
       COUNT(*) FILTER (WHERE processing_status = 'ready') AS ready
     FROM assets WHERE case_id = $1`,
    [caseId],
  );

  const { total, done, ready } = result.rows[0];
  if (Number(done) < Number(total)) return; // still processing

  if (Number(ready) > 0) {
    await pool.query(
      `UPDATE cases SET status = 'preprocessing_complete', updated_at = NOW() WHERE case_id = $1`,
      [caseId],
    );
  } else {
    await pool.query(
      `UPDATE cases SET status = 'preprocessing_failed', updated_at = NOW() WHERE case_id = $1`,
      [caseId],
    );
  }
}
