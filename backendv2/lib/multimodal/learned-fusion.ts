import type { Observation, Candidate, SourceType } from "./types";
import { generateCandidateId } from "./types";
import { getSession, runInference, float32Tensor, getFloat32Output } from "./onnx-inference";
import { fuseObservations as ruleFuseObservations } from "./fusion";
import { logger } from "../observability";

const ONNX_MODEL_NAME = "fusion_model";

const SOURCE_TYPE_INDEX: Record<SourceType, number> = {
  ocr: 0,
  classifier: 1,
  gemini: 2,
  text_parse: 3,
  catalog_lookup: 4,
  user_metadata: 5,
  logo_detector: 6,
  panel_similarity: 7,
  audio_detector: 8,
};
const NUM_SOURCE_TYPES = 9;

const FIELD_INDEX: Record<string, number> = {
  appliance_type: 0,
  brand: 1,
  model: 2,
  serial: 3,
  error_code: 4,
  symptom: 5,
};
const NUM_FIELDS = 6;

interface CandidateGroup {
  field: string;
  value: string;
  observations: Observation[];
}

function groupObservationsForFusion(observations: Observation[]): CandidateGroup[] {
  const grouped = new Map<string, CandidateGroup>();

  for (const obs of observations) {
    if (obs.field === "raw_ocr_text") continue;
    const normalizedValue = obs.value.trim().toLowerCase();
    if (!normalizedValue) continue;

    const key = `${obs.field}::${normalizedValue}`;
    if (!grouped.has(key)) {
      grouped.set(key, { field: obs.field, value: obs.value, observations: [] });
    }
    grouped.get(key)!.observations.push(obs);
  }

  return [...grouped.values()];
}

/**
 * Extracts a fixed-length feature vector for a candidate group.
 *
 * Features (per candidate group):
 *  - observation count (1)
 *  - mean confidence (1)
 *  - max confidence (1)
 *  - min confidence (1)
 *  - source type distribution (NUM_SOURCE_TYPES)
 *  - field one-hot (NUM_FIELDS)
 *  - number of distinct source types contributing (1)
 *  - has region OCR (1)
 *  - has catalog evidence (1)
 *  - number of conflicting values for this field across all groups (1)
 *
 * Total: 4 + NUM_SOURCE_TYPES + NUM_FIELDS + 4 = 23
 */
const FEATURE_DIM = 4 + NUM_SOURCE_TYPES + NUM_FIELDS + 4;

function extractFeatures(
  group: CandidateGroup,
  allGroups: CandidateGroup[],
): Float32Array {
  const features = new Float32Array(FEATURE_DIM);
  const obs = group.observations;

  features[0] = obs.length;

  const confidences = obs.map((o) => o.confidence);
  features[1] = confidences.reduce((a, b) => a + b, 0) / confidences.length;
  features[2] = Math.max(...confidences);
  features[3] = Math.min(...confidences);

  let offset = 4;
  for (const o of obs) {
    const idx = SOURCE_TYPE_INDEX[o.source_type];
    if (idx !== undefined) features[offset + idx] += 1 / obs.length;
  }
  offset += NUM_SOURCE_TYPES;

  const fieldIdx = FIELD_INDEX[group.field];
  if (fieldIdx !== undefined) features[offset + fieldIdx] = 1;
  offset += NUM_FIELDS;

  const distinctSources = new Set(obs.map((o) => o.source_type));
  features[offset] = distinctSources.size;

  features[offset + 1] = obs.some((o) => o.source_type === "ocr" && o.region_type !== null) ? 1 : 0;
  features[offset + 2] = obs.some((o) => o.source_type === "catalog_lookup") ? 1 : 0;

  const conflictingValues = allGroups.filter((g) => g.field === group.field).length;
  features[offset + 3] = conflictingValues;

  return features;
}

/**
 * Attempts learned fusion via ONNX model. Falls back to rule-based fusion if unavailable.
 */
export async function learnedFuseObservations(
  caseId: string,
  observations: Observation[],
): Promise<Candidate[]> {
  const handle = await getSession(ONNX_MODEL_NAME);
  if (!handle) {
    return ruleFuseObservations(caseId, observations);
  }

  const groups = groupObservationsForFusion(observations);
  if (groups.length === 0) return [];

  const candidates: Candidate[] = [];

  for (const group of groups) {
    try {
      const features = extractFeatures(group, groups);
      const input = float32Tensor(features, [1, FEATURE_DIM]);
      const result = await runInference(handle, { input });

      if (!result) {
        candidates.push(makeRuleFallbackCandidate(caseId, group));
        continue;
      }

      const outputKey = Object.keys(result)[0];
      const output = getFloat32Output(result[outputKey]);
      const confidence = Math.max(0, Math.min(1, output[0]));

      const displayValue = group.observations
        .sort((a, b) => b.confidence - a.confidence)[0].value;

      candidates.push({
        candidate_id: generateCandidateId(),
        case_id: caseId,
        candidate_type: group.field,
        value: displayValue,
        rank: 0,
        confidence,
        supporting_obs_ids: group.observations.map((o) => o.observation_id),
      });
    } catch (e) {
      logger.warn("Learned fusion failed for group, using rule fallback", {
        case_id: caseId,
        field: group.field,
        error: e instanceof Error ? e.message : String(e),
      });
      candidates.push(makeRuleFallbackCandidate(caseId, group));
    }
  }

  // Re-rank per field
  const byField = new Map<string, Candidate[]>();
  for (const c of candidates) {
    if (!byField.has(c.candidate_type)) byField.set(c.candidate_type, []);
    byField.get(c.candidate_type)!.push(c);
  }
  for (const fieldCandidates of byField.values()) {
    fieldCandidates.sort((a, b) => b.confidence - a.confidence);
    fieldCandidates.forEach((c, i) => { c.rank = i + 1; });
  }

  logger.info("Learned fusion completed", {
    case_id: caseId,
    candidates: candidates.length,
    model: ONNX_MODEL_NAME,
  });

  return candidates;
}

function makeRuleFallbackCandidate(caseId: string, group: CandidateGroup): Candidate {
  const obs = group.observations;
  const avgConf = obs.reduce((s, o) => s + o.confidence, 0) / obs.length;
  const displayValue = obs.sort((a, b) => b.confidence - a.confidence)[0].value;

  return {
    candidate_id: generateCandidateId(),
    case_id: caseId,
    candidate_type: group.field,
    value: displayValue,
    rank: 0,
    confidence: avgConf,
    supporting_obs_ids: obs.map((o) => o.observation_id),
  };
}
