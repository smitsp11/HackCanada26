import pool from "../db";
import { getPublicUrl, downloadFile, listFiles } from "../storage";
import { classifyAppliance } from "./classify";
import { runOcr } from "./ocr-regions";
import { extractEntities } from "./extract-entities";
import { extractSymptoms } from "./symptom-nlp";
import { fuseObservations } from "./fusion";
import { rankAndAssemble } from "./rank";
import { selectBestFrames } from "./frame-select";
import type { Observation, Candidate, UnderstandingOutput, UnderstandingStage } from "./types";
import { generateObservationId } from "./types";
import { logger } from "../observability";
import { hammingDistance, PERCEPTUAL_DUPLICATE_THRESHOLD } from "../phash";

type SendFn = (data: Record<string, unknown>) => void;

interface AssetRow {
  asset_id: string;
  asset_type: string;
  slot_key: string;
  cloudinary_url?: string;
  storage_uri_normalized?: string;
}

function sendProgress(send: SendFn, stage: UnderstandingStage) {
  send({ type: "understanding_progress", stage });
}

async function resolveImageUrl(asset: AssetRow): Promise<string> {
  if (asset.storage_uri_normalized) {
    try {
      return await getPublicUrl(asset.storage_uri_normalized);
    } catch {
      return asset.cloudinary_url || "";
    }
  }
  return asset.cloudinary_url || "";
}

async function persistObservations(observations: Observation[]): Promise<void> {
  if (observations.length === 0) return;

  const values: unknown[] = [];
  const placeholders: string[] = [];
  let idx = 1;

  for (const obs of observations) {
    placeholders.push(
      `($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}, $${idx + 6}, $${idx + 7}, $${idx + 8})`,
    );
    values.push(
      obs.observation_id,
      obs.case_id,
      obs.asset_id,
      obs.source_type,
      obs.field,
      obs.value,
      obs.confidence,
      obs.region_type,
      obs.metadata ? JSON.stringify(obs.metadata) : null,
    );
    idx += 9;
  }

  await pool.query(
    `INSERT INTO observations (observation_id, case_id, asset_id, source_type, field, value, confidence, region_type, metadata)
     VALUES ${placeholders.join(", ")}
     ON CONFLICT (observation_id) DO NOTHING`,
    values,
  );
}

async function persistCandidates(candidates: Candidate[]): Promise<void> {
  if (candidates.length === 0) return;

  const values: unknown[] = [];
  const placeholders: string[] = [];
  let idx = 1;

  for (const c of candidates) {
    placeholders.push(
      `($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}, $${idx + 6})`,
    );
    values.push(
      c.candidate_id,
      c.case_id,
      c.candidate_type,
      c.value,
      c.rank,
      c.confidence,
      c.supporting_obs_ids,
    );
    idx += 7;
  }

  await pool.query(
    `INSERT INTO identity_candidates (candidate_id, case_id, candidate_type, value, rank, confidence, supporting_obs_ids)
     VALUES ${placeholders.join(", ")}
     ON CONFLICT (candidate_id) DO NOTHING`,
    values,
  );
}

async function persistUnderstanding(output: UnderstandingOutput): Promise<void> {
  await pool.query(
    `INSERT INTO case_understanding
       (understanding_id, case_id, appliance_type_json, brand_candidates_json,
        model_candidates_json, error_codes_json, symptoms_json, fallback_status_json,
        resolved_identity_level)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (understanding_id) DO NOTHING`,
    [
      output.understanding_id,
      output.case_id,
      JSON.stringify(output.appliance_type),
      JSON.stringify(output.brand_candidates),
      JSON.stringify(output.model_candidates),
      JSON.stringify(output.error_codes),
      JSON.stringify(output.symptoms),
      JSON.stringify(output.fallback_status),
      output.fallback_status.resolved_identity_level,
    ],
  );
}

/**
 * Builds a human-readable device identification string from understanding output.
 */
export function buildDeviceString(output: UnderstandingOutput): string {
  const parts: string[] = [];

  if (output.brand_candidates.length > 0) {
    parts.push(output.brand_candidates[0].brand);
  }

  if (output.model_candidates.length > 0) {
    parts.push(output.model_candidates[0].model);
  }

  if (parts.length === 0 && output.appliance_type.top_prediction !== "unknown") {
    parts.push(output.appliance_type.top_prediction);
  }

  return parts.length > 0 ? parts.join(" ") : "Unknown appliance";
}

async function resolveVideoFrames(
  caseId: string,
  assets: AssetRow[],
): Promise<{ asset_id: string; url: string }[]> {
  const videoAssets = assets.filter((a) => a.asset_type === "video");
  if (videoAssets.length === 0) return [];

  const results: { asset_id: string; url: string }[] = [];

  for (const va of videoAssets) {
    try {
      const framesPrefix = `frames/${caseId}/${va.asset_id}`;
      const framePaths = await listFiles(framesPrefix);

      if (framePaths.length === 0) {
        logger.info("No extracted frames found for video asset", {
          case_id: caseId,
          asset_id: va.asset_id,
        });
        continue;
      }

      const frameBuffers: { storagePath: string; buffer: Buffer }[] = [];
      for (const fp of framePaths) {
        if (!fp.endsWith(".jpg") && !fp.endsWith(".jpeg") && !fp.endsWith(".png")) continue;
        try {
          const buf = await downloadFile(fp);
          frameBuffers.push({ storagePath: fp, buffer: buf });
        } catch {
          // Skip frames that can't be downloaded
        }
      }

      if (frameBuffers.length === 0) continue;

      const selected = await selectBestFrames(frameBuffers, 5, {
        case_id: caseId,
        asset_id: va.asset_id,
      });

      for (const frame of selected) {
        const publicUrl = await getPublicUrl(frame.storagePath);
        if (publicUrl) {
          results.push({ asset_id: va.asset_id, url: publicUrl });
        }
      }

      logger.info(`Selected ${selected.length}/${framePaths.length} video frames`, {
        case_id: caseId,
        asset_id: va.asset_id,
        low_quality_count: selected.filter((s) => s.lowQuality).length,
      });
    } catch (e) {
      logger.warn("Failed to resolve video frames", {
        case_id: caseId,
        asset_id: va.asset_id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return results;
}

async function deduplicateAssets(
  caseId: string,
  assets: AssetRow[],
  observations: Observation[],
): Promise<AssetRow[]> {
  const imageAssetIds = assets
    .filter((a) => a.asset_type === "image")
    .map((a) => a.asset_id);

  if (imageAssetIds.length < 2) return assets;

  try {
    const { rows } = await pool.query<{ asset_id: string; phash: string | null }>(
      `SELECT asset_id, phash FROM assets WHERE asset_id = ANY($1)`,
      [imageAssetIds],
    );

    const hashMap = new Map<string, string>();
    for (const row of rows) {
      if (row.phash) hashMap.set(row.asset_id, row.phash);
    }

    const skipIds = new Set<string>();
    const entries = [...hashMap.entries()];

    for (let i = 0; i < entries.length; i++) {
      if (skipIds.has(entries[i][0])) continue;
      for (let j = i + 1; j < entries.length; j++) {
        if (skipIds.has(entries[j][0])) continue;
        const dist = hammingDistance(entries[i][1], entries[j][1]);
        if (dist <= PERCEPTUAL_DUPLICATE_THRESHOLD) {
          skipIds.add(entries[j][0]);
          observations.push({
            observation_id: generateObservationId(),
            case_id: caseId,
            asset_id: entries[j][0],
            source_type: "classifier",
            field: "raw_ocr_text",
            value: `perceptual_duplicate_of:${entries[i][0]}`,
            confidence: 1 - dist / 64,
            region_type: null,
            metadata: {
              duplicate_source: entries[i][0],
              hamming_distance: dist,
              method: "perceptual_hash",
            },
          });
          await pool.query(
            `UPDATE assets SET duplicate_of = $2 WHERE asset_id = $1`,
            [entries[j][0], entries[i][0]],
          );
        }
      }
    }

    if (skipIds.size > 0) {
      logger.info(`Perceptual dedup removed ${skipIds.size} duplicate(s)`, { case_id: caseId });
      return assets.filter((a) => !skipIds.has(a.asset_id));
    }
  } catch (e) {
    logger.warn("Perceptual dedup check failed, proceeding with all assets", { case_id: caseId }, {
      error: e instanceof Error ? e.message : String(e),
    });
  }

  return assets;
}

/**
 * Runs the full multimodal understanding pipeline for a case.
 * Calls submodules sequentially, persists results, emits SSE events.
 */
export async function runUnderstandingPipeline(
  caseId: string,
  usableAssets: AssetRow[],
  symptom: string,
  applianceHint: string | undefined,
  caseMetadata: Record<string, unknown> | undefined,
  send: SendFn,
): Promise<UnderstandingOutput> {
  const ctx = { case_id: caseId };
  const startTime = Date.now();

  send({ type: "understanding_start" });
  logger.info("Understanding pipeline started", ctx);

  const allObservations: Observation[] = [];

  // 0. Perceptual dedup — skip near-duplicate image assets
  const dedupedAssets = await deduplicateAssets(caseId, usableAssets, allObservations);

  // 1. Classify appliance type (images + selected video frames)
  sendProgress(send, "classify");
  const imageAssets: { asset_id: string; url: string }[] = [];
  const imageUrls: string[] = [];

  for (const asset of dedupedAssets) {
    if (asset.asset_type === "image" || asset.slot_key === "model" || asset.slot_key === "additional") {
      const url = await resolveImageUrl(asset);
      if (url) {
        imageAssets.push({ asset_id: asset.asset_id, url });
        imageUrls.push(url);
      }
    }
  }

  // Resolve video frames from preprocessed frame extractions
  const videoFrameAssets = await resolveVideoFrames(caseId, dedupedAssets);
  imageAssets.push(...videoFrameAssets.map((vf) => ({ asset_id: vf.asset_id, url: vf.url })));
  imageUrls.push(...videoFrameAssets.map((vf) => vf.url));

  const { observations: classifyObs, result: classifyResult } =
    await classifyAppliance(caseId, imageUrls, applianceHint);
  allObservations.push(...classifyObs);

  // 2. OCR extraction
  sendProgress(send, "ocr");
  const { observations: ocrObs, ocrResults } = await runOcr(caseId, imageAssets);
  allObservations.push(...ocrObs);

  // 3. Entity extraction (brand, model, serial, error codes)
  sendProgress(send, "extract");
  const userMeta = caseMetadata
    ? {
        brand: caseMetadata.brand as string | undefined,
        model: caseMetadata.model as string | undefined,
        error_code: caseMetadata.error_code as string | undefined,
      }
    : undefined;
  const entityObs = await extractEntities(caseId, ocrResults, userMeta);
  allObservations.push(...entityObs);

  // 4. Symptom NLP
  sendProgress(send, "symptoms");
  const symptomObs = await extractSymptoms(caseId, symptom);
  allObservations.push(...symptomObs);

  // 5. Fusion
  sendProgress(send, "fusion");
  const candidates = fuseObservations(caseId, allObservations);

  // 6. Rank and assemble
  sendProgress(send, "rank");
  const output = rankAndAssemble(caseId, candidates, classifyResult, allObservations);

  // Persist to database
  try {
    await persistObservations(allObservations);
    await persistCandidates(candidates);
    await persistUnderstanding(output);
  } catch (e) {
    logger.warn("Failed to persist understanding results", ctx, {
      error: e instanceof Error ? e.message : String(e),
    });
  }

  const duration = Date.now() - startTime;
  logger.info("Understanding pipeline completed", ctx, {
    duration_ms: duration,
    identity_level: output.fallback_status.resolved_identity_level,
    brand_count: output.brand_candidates.length,
    model_count: output.model_candidates.length,
    symptom_count: output.symptoms.length,
  });

  send({ type: "understanding_complete", payload: output });

  return output;
}
