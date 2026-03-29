import pool from "./db";

const MAX_ASSETS_PER_CASE = parseInt(process.env.MAX_ASSETS_PER_CASE || "10", 10);
const MAX_TOTAL_BYTES_PER_CASE = parseInt(process.env.MAX_TOTAL_BYTES_PER_CASE || String(1024 * 1024 * 1024), 10);
const MAX_PENDING_PER_USER = parseInt(process.env.MAX_PENDING_PER_USER || "5", 10);

export interface QuotaResult {
  allowed: boolean;
  reason?: string;
}

export async function checkUploadQuota(
  caseId: string,
  userId: string | null,
): Promise<QuotaResult> {
  const assetCount = await pool.query(
    `SELECT COUNT(*) AS cnt, COALESCE(SUM(size_bytes), 0) AS total_bytes
     FROM assets WHERE case_id = $1`,
    [caseId],
  );

  const { cnt, total_bytes } = assetCount.rows[0];

  if (Number(cnt) >= MAX_ASSETS_PER_CASE) {
    return {
      allowed: false,
      reason: `Maximum ${MAX_ASSETS_PER_CASE} assets per case exceeded`,
    };
  }

  if (Number(total_bytes) >= MAX_TOTAL_BYTES_PER_CASE) {
    return {
      allowed: false,
      reason: `Total upload size exceeds ${Math.round(MAX_TOTAL_BYTES_PER_CASE / (1024 * 1024))} MB per case`,
    };
  }

  if (userId) {
    const pendingResult = await pool.query(
      `SELECT COUNT(*) AS pending
       FROM assets a
       JOIN cases c ON a.case_id = c.case_id
       WHERE c.user_id = $1 AND a.upload_status IN ('pending', 'awaiting_upload')`,
      [userId],
    );

    if (Number(pendingResult.rows[0].pending) >= MAX_PENDING_PER_USER) {
      return {
        allowed: false,
        reason: `Maximum ${MAX_PENDING_PER_USER} concurrent pending uploads per user exceeded`,
      };
    }
  }

  return { allowed: true };
}
