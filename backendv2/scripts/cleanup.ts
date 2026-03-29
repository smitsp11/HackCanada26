import dns from "node:dns";
import {
  getExpiredAssets,
  deleteAssetFiles,
  markAssetDeleted,
  getOrphanedCases,
  deleteCase,
  RETENTION_DAYS,
  ORPHAN_HOURS,
} from "../lib/retention";

dns.setDefaultResultOrder("ipv4first");

async function cleanup() {
  console.log(`[cleanup] Starting retention cleanup (retention=${RETENTION_DAYS}d, orphan=${ORPHAN_HOURS}h)`);

  const expired = await getExpiredAssets();
  console.log(`[cleanup] Found ${expired.length} expired assets`);

  for (const asset of expired) {
    try {
      await deleteAssetFiles(asset.asset_id);
      await markAssetDeleted(asset.asset_id);
      console.log(`[cleanup] Deleted asset ${asset.asset_id} from case ${asset.case_id}`);
    } catch (err) {
      console.error(`[cleanup] Failed to delete asset ${asset.asset_id}:`, err);
    }
  }

  const orphans = await getOrphanedCases();
  console.log(`[cleanup] Found ${orphans.length} orphaned cases`);

  for (const caseRow of orphans) {
    try {
      await deleteCase(caseRow.case_id);
      console.log(`[cleanup] Deleted orphaned case ${caseRow.case_id}`);
    } catch (err) {
      console.error(`[cleanup] Failed to delete case ${caseRow.case_id}:`, err);
    }
  }

  console.log("[cleanup] Done");
  process.exit(0);
}

cleanup().catch((err) => {
  console.error("[cleanup] Fatal error:", err);
  process.exit(1);
});
