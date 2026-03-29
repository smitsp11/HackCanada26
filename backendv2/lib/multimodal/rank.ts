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
  CONFIDENCE_PROBABLE,
  generateUnderstandingId,
} from "./types";
import type { ClassifyResult } from "./classify";

const CATALOG_MATCH_BONUS = 0.1;

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
 * Ranks candidates and determines fallback resolution level.
 * Assembles the final UnderstandingOutput.
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

  // Apply catalog match bonus to model candidates
  for (const mc of modelCandidates) {
    if (hasCatalogEvidence(mc, allObservations)) {
      mc.confidence = Math.min(1, mc.confidence + CATALOG_MATCH_BONUS);
    }
  }

  // Re-sort model candidates after bonus
  modelCandidates.sort((a, b) => b.confidence - a.confidence);
  modelCandidates.forEach((c, i) => {
    c.rank = i + 1;
  });

  // Build appliance type prediction
  const applianceType: ApplianceTypePrediction = {
    top_prediction: classifyResult.appliance_type,
    confidence: classifyResult.confidence,
    alternatives: classifyResult.alternatives,
  };

  // Build brand candidates output
  const brands: BrandCandidate[] = brandCandidates.map((c) => ({
    brand: c.value,
    confidence: c.confidence,
    evidence: c.supporting_obs_ids,
  }));

  // Build model candidates output
  const models: ModelCandidate[] = modelCandidates.map((c) => ({
    model: c.value,
    confidence: c.confidence,
    rank: c.rank,
    evidence: c.supporting_obs_ids,
  }));

  // Build error codes output
  const errorCodes: ErrorCode[] = errorCandidates.map((c) => ({
    value: c.value,
    confidence: c.confidence,
    source: c.supporting_obs_ids.join(","),
  }));

  // Build symptoms output
  const symptoms: SymptomTag[] = symptomCandidates.map((c) => ({
    tag: c.value,
    confidence: c.confidence,
    source: "text_parse",
  }));

  // Determine fallback level
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

  if (topModel && topModel.confidence >= CONFIDENCE_PROBABLE) {
    // Check if there's a close second model (series-level)
    level = "exact";
    exactModelResolved = true;
    scope.push("model", "brand", "appliance_type");
  } else if (topModel && topModel.confidence >= 0.40) {
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
