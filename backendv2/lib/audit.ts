import pool from "./db";

export type AuditEventType =
  | "asset_registered"
  | "asset_upload_completed"
  | "asset_validation_started"
  | "asset_validation_passed"
  | "asset_validation_failed"
  | "asset_preprocessing_started"
  | "asset_preprocessing_completed"
  | "asset_preprocessing_failed"
  | "asset_scan_clean"
  | "asset_scan_flagged"
  | "asset_duplicate_detected"
  | "asset_deleted"
  | "case_created"
  | "case_pipeline_started"
  | "case_pipeline_completed"
  | "case_pipeline_failed"
  | "case_deleted"
  | "quota_exceeded";

export interface AuditContext {
  case_id?: string;
  asset_id?: string;
  job_id?: string;
  user_id?: string;
  request_id?: string;
}

export async function auditLog(
  eventType: AuditEventType,
  ctx: AuditContext,
  details?: Record<string, unknown>,
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO audit_logs (event_type, case_id, asset_id, job_id, user_id, request_id, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        eventType,
        ctx.case_id ?? null,
        ctx.asset_id ?? null,
        ctx.job_id ?? null,
        ctx.user_id ?? null,
        ctx.request_id ?? null,
        details ? JSON.stringify(details) : null,
      ],
    );
  } catch (err) {
    // Audit logging must never crash the caller
    console.error("[audit] failed to write audit log:", err);
  }
}
