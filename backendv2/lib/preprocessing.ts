import sharp from "sharp";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, unlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pool from "./db";
import { downloadFile, uploadDerived } from "./storage";
import { computeChecksum, validateMagicBytes } from "./validation";
import { createJob, updateJobStatus, incrementRetry } from "./jobs";
import { auditLog } from "./audit";
import { logger } from "./observability";
import { scanFile } from "./malware-scan";
import { withRetry, PermanentError } from "./retry";
import { computeDHash } from "./phash";

const execAsync = promisify(exec);

const THUMBNAIL_SIZE = 256;
const NORMALIZED_MAX_WIDTH = 1920;
const FRAME_INTERVAL_SEC = 1;

export async function preprocessAsset(
  caseId: string,
  assetId: string,
  assetType: string,
  storagePath: string,
): Promise<void> {
  const jobId = await createJob(caseId, assetId, "media_preprocessing");
  const ctx = { case_id: caseId, asset_id: assetId, job_id: jobId };
  const startTime = Date.now();

  try {
    await updateJobStatus(jobId, "processing");

    await pool.query(
      `UPDATE assets SET validation_status = 'validating', processing_status = 'processing' WHERE asset_id = $1`,
      [assetId],
    );

    await auditLog("asset_preprocessing_started", ctx);
    logger.info("Preprocessing started", ctx);

    const buffer = await withRetry(() => downloadFile(storagePath), {
      maxRetries: 3,
      onRetry: async (attempt) => {
        await incrementRetry(jobId);
        logger.warn(`Download retry ${attempt}`, ctx);
      },
    });

    // Malware scan before any processing
    const mimeResult = await pool.query(
      `SELECT mime_type FROM assets WHERE asset_id = $1`,
      [assetId],
    );
    const declaredMime = mimeResult.rows[0]?.mime_type || "";
    const scanResult = scanFile(buffer, declaredMime);

    await pool.query(
      `UPDATE assets SET scan_status = $2 WHERE asset_id = $1`,
      [assetId, scanResult.verdict],
    );

    if (scanResult.verdict === "flagged") {
      await auditLog("asset_scan_flagged", ctx, { reason: scanResult.reason });
      logger.warn("File flagged by malware scan", ctx, { reason: scanResult.reason });
      throw new PermanentError(
        `File flagged: ${scanResult.reason}`,
        "ERR_SCAN_FLAGGED",
      );
    }

    await auditLog("asset_scan_clean", ctx);

    const checksum = computeChecksum(buffer);
    await pool.query(
      `UPDATE assets SET checksum_sha256 = $2 WHERE asset_id = $1`,
      [assetId, checksum],
    );

    await auditLog("asset_validation_passed", ctx, { checksum });

    if (assetType === "image") {
      await preprocessImage(caseId, assetId, buffer, storagePath, jobId);
    } else if (assetType === "video") {
      await preprocessVideo(caseId, assetId, buffer, storagePath, jobId);
    }

    await pool.query(
      `UPDATE assets SET validation_status = 'validated', processing_status = 'ready' WHERE asset_id = $1`,
      [assetId],
    );

    const durationMs = Date.now() - startTime;
    await updateJobStatus(jobId, "completed", { checksum, duration_ms: durationMs });
    await auditLog("asset_preprocessing_completed", ctx, { duration_ms: durationMs, checksum });
    logger.metric({
      event: "preprocessing_completed",
      duration_ms: durationMs,
      file_size_bytes: buffer.length,
      mime_type: declaredMime,
    }, ctx);

    await updateCaseStatusIfReady(caseId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const code = err instanceof PermanentError ? err.code : "ERR_PREPROCESSING_FAILED";

    logger.error(`Preprocessing failed for asset ${assetId}: ${message}`, ctx);
    await auditLog("asset_preprocessing_failed", ctx, { error: message, code });

    await pool.query(
      `UPDATE assets SET validation_status = 'failed', processing_status = 'failed' WHERE asset_id = $1`,
      [assetId],
    );
    await updateJobStatus(jobId, "failed", null, message, code);

    await updateCaseStatusIfReady(caseId);
  }
}

async function preprocessImage(
  caseId: string,
  assetId: string,
  buffer: Buffer,
  rawPath: string,
  jobId: string,
): Promise<void> {
  const ctx = { case_id: caseId, asset_id: assetId, job_id: jobId };
  const image = sharp(buffer);
  const metadata = await image.metadata();

  const { valid } = validateMagicBytes(buffer, `image/${metadata.format}`);
  if (!valid && metadata.format) {
    logger.warn(`Magic byte mismatch for format: ${metadata.format}`, ctx);
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

  // Strip ALL metadata (including GPS) from normalized derivative; keep raw untouched
  const normalizedBuffer = await sharp(buffer)
    .rotate()
    .resize({ width: NORMALIZED_MAX_WIDTH, withoutEnlargement: true })
    .withMetadata(false)
    .jpeg({ quality: 85 })
    .toBuffer();

  const normalizedPath = rawPath.replace("raw/", "normalized/").replace(/\.[^.]+$/, ".jpg");
  await withRetry(() => uploadDerived(normalizedPath, normalizedBuffer, "image/jpeg"), {
    maxRetries: 2,
    onRetry: async (attempt) => {
      await incrementRetry(jobId);
      logger.warn(`Upload normalized retry ${attempt}`, ctx);
    },
  });

  const thumbnailBuffer = await sharp(buffer)
    .rotate()
    .resize({ width: THUMBNAIL_SIZE, height: THUMBNAIL_SIZE, fit: "cover" })
    .withMetadata(false)
    .jpeg({ quality: 70 })
    .toBuffer();

  const thumbPath = rawPath.replace("raw/", "thumbs/").replace(/\.[^.]+$/, "_thumb.jpg");
  await withRetry(() => uploadDerived(thumbPath, thumbnailBuffer, "image/jpeg"), {
    maxRetries: 2,
    onRetry: async (attempt) => {
      await incrementRetry(jobId);
      logger.warn(`Upload thumbnail retry ${attempt}`, ctx);
    },
  });

  await pool.query(
    `UPDATE assets SET storage_uri_normalized = $2, storage_uri_thumbnail = $3 WHERE asset_id = $1`,
    [assetId, normalizedPath, thumbPath],
  );

  try {
    const phash = await computeDHash(normalizedBuffer);
    await pool.query(
      `UPDATE assets SET phash = $2 WHERE asset_id = $1`,
      [assetId, phash],
    );
  } catch (e) {
    logger.warn("Perceptual hash computation failed", ctx, {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

async function preprocessVideo(
  caseId: string,
  assetId: string,
  buffer: Buffer,
  rawPath: string,
  jobId: string,
): Promise<void> {
  const ctx = { case_id: caseId, asset_id: assetId, job_id: jobId };

  const ffprobeAvailable = await checkFfprobe();
  if (!ffprobeAvailable) {
    logger.warn("ffprobe/ffmpeg not available, falling back to basic metadata", ctx);
    await pool.query(
      `INSERT INTO asset_metadata (asset_id, derived_metadata_json)
       VALUES ($1, $2)
       ON CONFLICT (asset_id) DO UPDATE SET derived_metadata_json = $2`,
      [assetId, JSON.stringify({ size_bytes: buffer.length, note: "ffmpeg unavailable" })],
    );
    return;
  }

  const tmpDir = join(tmpdir(), `opera-video-${assetId}`);
  const inputPath = join(tmpDir, "input.mp4");

  try {
    await mkdir(tmpDir, { recursive: true });
    await writeFile(inputPath, buffer);

    // Extract metadata with ffprobe
    const probeData = await extractVideoMetadata(inputPath);

    await pool.query(
      `INSERT INTO asset_metadata (asset_id, width, height, duration_sec, codec, frame_rate, derived_metadata_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (asset_id) DO UPDATE
       SET width = $2, height = $3, duration_sec = $4, codec = $5, frame_rate = $6, derived_metadata_json = $7`,
      [
        assetId,
        probeData.width ?? null,
        probeData.height ?? null,
        probeData.duration ?? null,
        probeData.codec ?? null,
        probeData.frameRate ?? null,
        JSON.stringify(probeData),
      ],
    );

    // Generate poster thumbnail from first frame
    const thumbPath = rawPath.replace("raw/", "thumbs/").replace(/\.[^.]+$/, "_poster.jpg");
    try {
      const posterPath = join(tmpDir, "poster.jpg");
      await execAsync(
        `ffmpeg -y -i "${inputPath}" -vframes 1 -q:v 3 "${posterPath}"`,
      );
      const { readFile } = await import("node:fs/promises");
      const posterBuffer = await readFile(posterPath);
      await withRetry(() => uploadDerived(thumbPath, posterBuffer, "image/jpeg"), {
        maxRetries: 2,
        onRetry: async (attempt) => {
          await incrementRetry(jobId);
          logger.warn(`Upload poster retry ${attempt}`, ctx);
        },
      });

      await pool.query(
        `UPDATE assets SET storage_uri_thumbnail = $2 WHERE asset_id = $1`,
        [assetId, thumbPath],
      );
    } catch (e) {
      logger.warn("Poster thumbnail generation failed", ctx, {
        error: e instanceof Error ? e.message : String(e),
      });
    }

    // Extract frames at fixed intervals
    if (probeData.duration && probeData.duration > 0) {
      try {
        const framesDir = join(tmpDir, "frames");
        await mkdir(framesDir, { recursive: true });

        await execAsync(
          `ffmpeg -y -i "${inputPath}" -vf "fps=1/${FRAME_INTERVAL_SEC}" "${framesDir}/frame_%04d.jpg"`,
        );

        const { readdir, readFile } = await import("node:fs/promises");
        const frameFiles = (await readdir(framesDir)).filter((f) => f.endsWith(".jpg")).sort();

        for (const frameFile of frameFiles) {
          const framePath = rawPath.replace("raw/", "frames/").replace(/\.[^.]+$/, `/${frameFile}`);
          const frameBuffer = await readFile(join(framesDir, frameFile));
          await uploadDerived(framePath, frameBuffer, "image/jpeg");
        }

        logger.info(`Extracted ${frameFiles.length} frames`, ctx);
      } catch (e) {
        logger.warn("Frame extraction failed", ctx, {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } finally {
    // Clean up temp files
    try {
      const { rm } = await import("node:fs/promises");
      await rm(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

interface VideoProbeData {
  width?: number;
  height?: number;
  duration?: number;
  codec?: string;
  frameRate?: number;
  bitrate?: number;
  format?: string;
}

async function extractVideoMetadata(inputPath: string): Promise<VideoProbeData> {
  try {
    const { stdout } = await execAsync(
      `ffprobe -v quiet -print_format json -show_format -show_streams "${inputPath}"`,
    );
    const probe = JSON.parse(stdout);
    const videoStream = probe.streams?.find((s: { codec_type: string }) => s.codec_type === "video");
    const format = probe.format;

    let frameRate: number | undefined;
    if (videoStream?.r_frame_rate) {
      const [num, den] = videoStream.r_frame_rate.split("/").map(Number);
      if (den > 0) frameRate = Math.round((num / den) * 100) / 100;
    }

    return {
      width: videoStream?.width,
      height: videoStream?.height,
      duration: format?.duration ? parseFloat(format.duration) : undefined,
      codec: videoStream?.codec_name,
      frameRate,
      bitrate: format?.bit_rate ? parseInt(format.bit_rate) : undefined,
      format: format?.format_name,
    };
  } catch {
    return {};
  }
}

async function checkFfprobe(): Promise<boolean> {
  try {
    await execAsync("ffprobe -version");
    return true;
  } catch {
    return false;
  }
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
  if (Number(done) < Number(total)) return;

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
