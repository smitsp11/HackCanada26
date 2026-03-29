import pool from "./db";
import { supabase, BUCKET } from "./storage";
import { auditLog } from "./audit";

const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS || "30", 10);
const ORPHAN_HOURS = parseInt(process.env.ORPHAN_CASE_HOURS || "24", 10);

export async function getExpiredAssets(
  retentionDays: number = RETENTION_DAYS,
): Promise<Array<{ asset_id: string; case_id: string; storage_uri_raw: string | null; storage_uri_normalized: string | null; storage_uri_thumbnail: string | null }>> {
  const result = await pool.query(
    `SELECT asset_id, case_id, storage_uri_raw, storage_uri_normalized, storage_uri_thumbnail
     FROM assets
     WHERE created_at < NOW() - INTERVAL '1 day' * $1
       AND processing_status != 'deleted'`,
    [retentionDays],
  );
  return result.rows;
}

async function removeStorageObject(path: string): Promise<boolean> {
  const { error } = await supabase.storage.from(BUCKET).remove([path]);
  return !error;
}

export async function deleteAssetFiles(assetId: string): Promise<void> {
  const result = await pool.query(
    `SELECT asset_id, case_id, storage_uri_raw, storage_uri_normalized, storage_uri_thumbnail
     FROM assets WHERE asset_id = $1`,
    [assetId],
  );

  if (result.rows.length === 0) return;

  const asset = result.rows[0];
  const paths = [
    asset.storage_uri_raw,
    asset.storage_uri_normalized,
    asset.storage_uri_thumbnail,
  ].filter(Boolean);

  for (const path of paths) {
    await removeStorageObject(path);
  }

  await auditLog("asset_deleted", {
    asset_id: assetId,
    case_id: asset.case_id,
  }, { deleted_paths: paths });
}

export async function markAssetDeleted(assetId: string): Promise<void> {
  await pool.query(
    `UPDATE assets
     SET processing_status = 'deleted',
         storage_uri_raw = NULL,
         storage_uri_normalized = NULL,
         storage_uri_thumbnail = NULL
     WHERE asset_id = $1`,
    [assetId],
  );
}

export async function getOrphanedCases(
  orphanHours: number = ORPHAN_HOURS,
): Promise<Array<{ case_id: string }>> {
  const result = await pool.query(
    `SELECT c.case_id
     FROM cases c
     LEFT JOIN assets a ON c.case_id = a.case_id
     WHERE c.status = 'created'
       AND c.created_at < NOW() - INTERVAL '1 hour' * $1
     GROUP BY c.case_id
     HAVING COUNT(a.asset_id) = 0`,
    [orphanHours],
  );
  return result.rows;
}

export async function deleteCase(caseId: string): Promise<void> {
  const assets = await pool.query(
    `SELECT asset_id FROM assets WHERE case_id = $1`,
    [caseId],
  );

  for (const row of assets.rows) {
    await deleteAssetFiles(row.asset_id);
  }

  await pool.query(`DELETE FROM cases WHERE case_id = $1`, [caseId]);

  await auditLog("case_deleted", { case_id: caseId }, { reason: "retention_cleanup" });
}

export { RETENTION_DAYS, ORPHAN_HOURS };
