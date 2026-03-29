import type {
  Candidate,
  UnderstandingOutput,
  ApplianceTypePrediction,
  BrandCandidate,
  ModelCandidate,
  ErrorCode,
  SymptomTag,
  FallbackStatus,
  IdentityLevel,
} from "./types";
import {
  CONFIDENCE_HIGH,
  CONFIDENCE_PROBABLE,
  CONFIDENCE_WEAK,
  generateUnderstandingId,
} from "./types";
import type { ClassifyResult } from "./classify";
import { getSession, runInference, float32Tensor, getFloat32Output } from "./onnx-inference";
import { rankAndAssemble as heuristicRankAndAssemble } from "./rank";
import { logger } from "../observability";

const ONNX_MODEL_NAME = "ranking_model";

/**
 * Feature vector per candidate for the ranking model.
 * - raw confidence (1)
 * - number of supporting observations (1)
 * - number of distinct source types (1)
 * - has catalog evidence (1)
 * - candidate type one-hot (6): appliance_type, brand, model, error_code, symptom, other
 * - rank from heuristic (1)
 * - confidence gap to next candidate in same field (1)
 * Total: 12
 */
const RANK_FEATURE_DIM = 12;

function extractRankFeatures(
  candidate: Candidate,
  allCandidates: Candidate[],
  allObservations: { observation_id: string; source_type: string }[],
): Float32Array {
  const features = new Float32Array(RANK_FEATURE_DIM);

  features[0] = candidate.confidence;
  features[1] = candidate.supporting_obs_ids.length;

  const sources = new Set<string>();
  let hasCatalog = false;
  for (const obsId of candidate.supporting_obs_ids) {
    const obs = allObservations.find((o) => o.observation_id === obsId);
    if (obs) {
      sources.add(obs.source_type);
      if (obs.source_type === "catalog_lookup") hasCatalog = true;
    }
  }
  features[2] = sources.size;
  features[3] = hasCatalog ? 1 : 0;

  const typeMap: Record<string, number> = {
    appliance_type: 0, brand: 1, model: 2, error_code: 3, symptom: 4,
  };
  const typeIdx = typeMap[candidate.candidate_type] ?? 5;
  features[4 + typeIdx] = 1;

  features[10] = candidate.rank;

  const sameField = allCandidates
    .filter((c) => c.candidate_type === candidate.candidate_type)
    .sort((a, b) => b.confidence - a.confidence);
  const myIdx = sameField.findIndex((c) => c.candidate_id === candidate.candidate_id);
  const nextConf = myIdx >= 0 && myIdx + 1 < sameField.length
    ? sameField[myIdx + 1].confidence
    : 0;
  features[11] = candidate.confidence - nextConf;

  return features;
}

/**
 * Attempts learned ranking via ONNX model. Falls back to heuristic ranking if unavailable.
 */
export async function learnedRankAndAssemble(
  caseId: string,
  candidates: Candidate[],
  classifyResult: ClassifyResult,
  allObservations: { observation_id: string; source_type: string }[],
): Promise<UnderstandingOutput> {
  const handle = await getSession(ONNX_MODEL_NAME);
  if (!handle) {
    return heuristicRankAndAssemble(caseId, candidates, classifyResult, allObservations);
  }

  const rescoredCandidates: Candidate[] = [];

  for (const candidate of candidates) {
    try {
      const features = extractRankFeatures(candidate, candidates, allObservations);
      const input = float32Tensor(features, [1, RANK_FEATURE_DIM]);
      const result = await runInference(handle, { input });

      if (!result) {
        rescoredCandidates.push(candidate);
        continue;
      }

      const outputKey = Object.keys(result)[0];
      const output = getFloat32Output(result[outputKey]);
      const newConfidence = Math.max(0, Math.min(1, output[0]));

      rescoredCandidates.push({ ...candidate, confidence: newConfidence });
    } catch {
      rescoredCandidates.push(candidate);
    }
  }

  // Re-rank per field after rescoring
  const byField = new Map<string, Candidate[]>();
  for (const c of rescoredCandidates) {
    if (!byField.has(c.candidate_type)) byField.set(c.candidate_type, []);
    byField.get(c.candidate_type)!.push(c);
  }
  for (const fieldCandidates of byField.values()) {
    fieldCandidates.sort((a, b) => b.confidence - a.confidence);
    fieldCandidates.forEach((c, i) => { c.rank = i + 1; });
  }

  const brandCandidates = (byField.get("brand") || []).sort((a, b) => a.rank - b.rank);
  const modelCandidates = (byField.get("model") || []).sort((a, b) => a.rank - b.rank);
  const errorCandidates = (byField.get("error_code") || []).sort((a, b) => a.rank - b.rank);
  const symptomCandidates = (byField.get("symptom") || []).sort((a, b) => a.rank - b.rank);

  const applianceType: ApplianceTypePrediction = {
    top_prediction: classifyResult.appliance_type,
    confidence: classifyResult.confidence,
    alternatives: classifyResult.alternatives,
  };

  const brands: BrandCandidate[] = brandCandidates.map((c) => ({
    brand: c.value,
    confidence: c.confidence,
    evidence: c.supporting_obs_ids,
  }));

  const models: ModelCandidate[] = modelCandidates.map((c) => ({
    model: c.value,
    confidence: c.confidence,
    rank: c.rank,
    evidence: c.supporting_obs_ids,
  }));

  const errorCodes: ErrorCode[] = errorCandidates.map((c) => ({
    value: c.value,
    confidence: c.confidence,
    source: c.supporting_obs_ids.join(","),
  }));

  const symptoms: SymptomTag[] = symptomCandidates.map((c) => ({
    tag: c.value,
    confidence: c.confidence,
    source: "text_parse",
  }));

  const topModel = models[0];
  const topBrand = brands[0];
  const fallbackStatus = determineFallback(topModel, topBrand, applianceType);

  logger.info("Learned ranking completed", {
    case_id: caseId,
    candidates: rescoredCandidates.length,
    model: ONNX_MODEL_NAME,
    identity_level: fallbackStatus.resolved_identity_level,
  });

  return {
    case_id: caseId,
    understanding_id: generateUnderstandingId(),
    appliance_type: applianceType,
    brand_candidates: brands,
    model_candidates: models,
    error_codes: errorCodes,
    symptoms,
    fallback_status: fallbackStatus,
  };
}

function determineFallback(
  topModel: ModelCandidate | undefined,
  topBrand: BrandCandidate | undefined,
  applianceType: ApplianceTypePrediction,
): FallbackStatus {
  let level: IdentityLevel = "type_only";
  let exactModelResolved = false;
  const scope: string[] = [];

  if (topModel && topModel.confidence >= CONFIDENCE_HIGH) {
    level = "exact";
    exactModelResolved = true;
    scope.push("model", "brand", "appliance_type");
  } else if (topModel && topModel.confidence >= CONFIDENCE_PROBABLE) {
    level = "exact";
    exactModelResolved = true;
    scope.push("model", "brand", "appliance_type");
  } else if (topModel && topModel.confidence >= CONFIDENCE_WEAK) {
    level = "series";
    scope.push("brand", "appliance_type", "error_code", "symptoms");
  } else if (topBrand && topBrand.confidence >= 0.50) {
    level = "brand_plus_type";
    scope.push("brand", "appliance_type", "error_code", "symptoms");
  } else {
    level = "type_only";
    scope.push("appliance_type", "symptoms");
  }

  if (applianceType.confidence >= CONFIDENCE_PROBABLE && !scope.includes("appliance_type")) {
    scope.push("appliance_type");
  }

  return {
    resolved_identity_level: level,
    exact_model_resolved: exactModelResolved,
    recommended_retrieval_scope: scope,
  };
}
