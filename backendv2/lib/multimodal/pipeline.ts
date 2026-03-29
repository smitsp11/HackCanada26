import pool from "../db";
import { getPublicUrl } from "../storage";
import { classifyAppliance } from "./classify";
import { runOcr } from "./ocr-regions";
import { extractEntities } from "./extract-entities";
import { extractSymptoms } from "./symptom-nlp";
import { fuseObservations } from "./fusion";
import { rankAndAssemble } from "./rank";
import type { Observation, Candidate, UnderstandingOutput, UnderstandingStage } from "./types";
import { logger } from "../observability";

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

  // 1. Classify appliance type
  sendProgress(send, "classify");
  const imageAssets: { asset_id: string; url: string }[] = [];
  const imageUrls: string[] = [];

  for (const asset of usableAssets) {
    if (asset.asset_type === "image" || asset.slot_key === "model" || asset.slot_key === "additional") {
      const url = await resolveImageUrl(asset);
      if (url) {
        imageAssets.push({ asset_id: asset.asset_id, url });
        imageUrls.push(url);
      }
    }
  }

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
