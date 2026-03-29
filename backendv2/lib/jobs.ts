import pool from "./db";

export async function createJob(
  caseId: string,
  assetId: string | null,
  jobType: string,
): Promise<string> {
  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  await pool.query(
    `INSERT INTO jobs (job_id, case_id, asset_id, job_type, status, created_at)
     VALUES ($1, $2, $3, $4, 'queued', NOW())`,
    [jobId, caseId, assetId, jobType],
  );

  return jobId;
}

export async function updateJobStatus(
  jobId: string,
  status: string,
  result?: Record<string, unknown> | null,
  errorMessage?: string | null,
  errorCode?: string | null,
): Promise<void> {
  const completedAt = ["completed", "failed"].includes(status) ? "NOW()" : "NULL";

  await pool.query(
    `UPDATE jobs
     SET status = $2,
         result = COALESCE($3, result),
         error_message = COALESCE($4, error_message),
         error_code = COALESCE($5, error_code),
         completed_at = ${completedAt}
     WHERE job_id = $1`,
    [
      jobId,
      status,
      result ? JSON.stringify(result) : null,
      errorMessage ?? null,
      errorCode ?? null,
    ],
  );
}

export async function incrementRetry(jobId: string): Promise<number> {
  const result = await pool.query(
    `UPDATE jobs SET retry_count = retry_count + 1 WHERE job_id = $1 RETURNING retry_count`,
    [jobId],
  );
  return result.rows[0]?.retry_count ?? 0;
}

export async function getJobsForCase(caseId: string) {
  const result = await pool.query(
    `SELECT job_id, case_id, asset_id, job_type, status,
            result, error_code, error_message, retry_count,
            created_at, completed_at
     FROM jobs WHERE case_id = $1
     ORDER BY created_at`,
    [caseId],
  );
  return result.rows;
}

export async function getJobsForAsset(assetId: string) {
  const result = await pool.query(
    `SELECT job_id, job_type, status, result, error_code, error_message,
            retry_count, created_at, completed_at
     FROM jobs WHERE asset_id = $1
     ORDER BY created_at`,
    [assetId],
  );
  return result.rows;
}
