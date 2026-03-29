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

const CATALOG_MATCH_BONUS = 0.1;
// Cap prevents a single catalog_lookup (weight 1.0, confidence 0.95) from reaching 1.0
// after bonus. A score of 1.0 should require multi-source corroboration, not one source.
const POST_BONUS_CONFIDENCE_CAP = 0.97;
const VARIANT_EDIT_DISTANCE_THRESHOLD = 2;

function pickCandidates(candidates: Candidate[], type: string): Candidate[] {
  return candidates
    .filter((c) => c.candidate_type === type)
    .sort((a, b) => a.rank - b.rank);
}

function hasCatalogEvidence(c: Candidate, allObs: { observation_id: string; source_type: string }[]): boolean {
  return c.supporting_obs_ids.some((id) => {
    const obs = allObs.find((o) => o.observation_id === id);
    return obs?.source_type === "catalog_lookup";
  });
}

/**
 * Computes Levenshtein edit distance between two strings.
 */
function editDistance(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;
  const dp: number[][] = Array.from({ length: la + 1 }, () => Array(lb + 1).fill(0));

  for (let i = 0; i <= la; i++) dp[i][0] = i;
  for (let j = 0; j <= lb; j++) dp[0][j] = j;

  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }

  return dp[la][lb];
}

/**
 * Detects near-variant model pairs (differing by 1-2 suffix characters)
 * and flags them rather than collapsing.
 */
function tagNearVariants(models: ModelCandidate[]): void {
  if (models.length < 2) return;

  for (let i = 0; i < models.length; i++) {
    for (let j = i + 1; j < models.length; j++) {
      const normA = models[i].model.toUpperCase().replace(/[\s\-/]/g, "");
      const normB = models[j].model.toUpperCase().replace(/[\s\-/]/g, "");
      const dist = editDistance(normA, normB);

      if (dist > 0 && dist <= VARIANT_EDIT_DISTANCE_THRESHOLD) {
        models[i].near_variant = true;
        models[j].near_variant = true;
      }
    }
  }
}

/**
 * Ranks candidates and determines fallback resolution level.
 * Uses confidence band constants, catalog bonus, and near-variant detection.
 */
export function rankAndAssemble(
  caseId: string,
  candidates: Candidate[],
  classifyResult: ClassifyResult,
  allObservations: { observation_id: string; source_type: string }[],
): UnderstandingOutput {
  const brandCandidates = pickCandidates(candidates, "brand");
  const modelCandidates = pickCandidates(candidates, "model");
  const errorCandidates = pickCandidates(candidates, "error_code");
  const symptomCandidates = pickCandidates(candidates, "symptom");

  for (const mc of modelCandidates) {
    if (hasCatalogEvidence(mc, allObservations)) {
      mc.confidence = Math.min(POST_BONUS_CONFIDENCE_CAP, mc.confidence + CATALOG_MATCH_BONUS);
    }
  }

  modelCandidates.sort((a, b) => b.confidence - a.confidence);
  modelCandidates.forEach((c, i) => {
    c.rank = i + 1;
  });

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

  tagNearVariants(models);

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
    // High-probable range: still exact if no near-variant ambiguity
    if (topModel.near_variant) {
      level = "series";
      scope.push("brand", "appliance_type", "error_code", "symptoms");
    } else {
      level = "exact";
      exactModelResolved = true;
      scope.push("model", "brand", "appliance_type");
    }
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
