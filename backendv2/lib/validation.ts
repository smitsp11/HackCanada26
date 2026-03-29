import crypto from "node:crypto";
import pool from "./db";

const ALLOWED_IMAGE_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

const ALLOWED_VIDEO_MIMES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
]);

const MAGIC_BYTES: Array<{ mime: string; bytes: number[]; offset?: number }> = [
  { mime: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { mime: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47] },
  { mime: "image/webp", bytes: [0x52, 0x49, 0x46, 0x46], offset: 0 },
  { mime: "image/gif", bytes: [0x47, 0x49, 0x46] },
  { mime: "video/mp4", bytes: [0x66, 0x74, 0x79, 0x70], offset: 4 },
  { mime: "video/quicktime", bytes: [0x66, 0x74, 0x79, 0x70], offset: 4 },
  { mime: "video/webm", bytes: [0x1a, 0x45, 0xdf, 0xa3] },
];

const SIZE_LIMITS: Record<string, number> = {
  image: 20 * 1024 * 1024, // 20 MB
  video: 500 * 1024 * 1024, // 500 MB
};

export function isAllowedMime(mime: string, assetType: string): boolean {
  if (assetType === "image") return ALLOWED_IMAGE_MIMES.has(mime);
  if (assetType === "video") return ALLOWED_VIDEO_MIMES.has(mime);
  return false;
}

export function validateMagicBytes(
  buffer: Buffer,
  declaredMime: string,
): { valid: boolean; detectedMime: string | null } {
  for (const sig of MAGIC_BYTES) {
    const offset = sig.offset ?? 0;
    if (buffer.length < offset + sig.bytes.length) continue;

    const match = sig.bytes.every(
      (b, i) => buffer[offset + i] === b,
    );
    if (match) {
      const compatible =
        sig.mime === declaredMime ||
        (sig.mime === "video/quicktime" && declaredMime === "video/mp4") ||
        (sig.mime === "video/mp4" && declaredMime === "video/quicktime");

      return { valid: compatible, detectedMime: sig.mime };
    }
  }

  return { valid: false, detectedMime: null };
}

export function validateSizeLimits(
  sizeBytes: number,
  assetType: string,
): { valid: boolean; limit: number } {
  const limit = SIZE_LIMITS[assetType] ?? SIZE_LIMITS.image;
  return { valid: sizeBytes <= limit, limit };
}

export function computeChecksum(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export async function checkDuplicate(
  caseId: string,
  checksum: string,
): Promise<{ isDuplicate: boolean; existingAssetId: string | null }> {
  const result = await pool.query(
    `SELECT asset_id FROM assets
     WHERE case_id = $1 AND checksum_sha256 = $2
     LIMIT 1`,
    [caseId, checksum],
  );

  if (result.rows.length > 0) {
    return { isDuplicate: true, existingAssetId: result.rows[0].asset_id };
  }
  return { isDuplicate: false, existingAssetId: null };
}

export {
  ALLOWED_IMAGE_MIMES,
  ALLOWED_VIDEO_MIMES,
  SIZE_LIMITS,
};
