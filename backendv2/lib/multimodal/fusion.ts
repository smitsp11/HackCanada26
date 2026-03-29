import type { Observation, Candidate, SourceType } from "./types";
import { generateCandidateId } from "./types";

interface GroupedObservations {
  [field: string]: { [value: string]: Observation[] };
}

const CORROBORATION_BOOST = 0.08;
const CONTRADICTION_PENALTY = 0.1;

export const SOURCE_WEIGHT_CATALOG = 1.0;
export const SOURCE_WEIGHT_GEMINI = 0.85;
export const SOURCE_WEIGHT_TEXT_PARSE = 0.70;
export const SOURCE_WEIGHT_OCR = 0.65;
export const SOURCE_WEIGHT_USER_METADATA = 0.50;

const SOURCE_WEIGHTS: Record<SourceType, number> = {
  catalog_lookup: SOURCE_WEIGHT_CATALOG,
  gemini: SOURCE_WEIGHT_GEMINI,
  text_parse: SOURCE_WEIGHT_TEXT_PARSE,
  classifier: SOURCE_WEIGHT_GEMINI,
  ocr: SOURCE_WEIGHT_OCR,
  user_metadata: SOURCE_WEIGHT_USER_METADATA,
};

function getSourceWeight(sourceType: SourceType): number {
  return SOURCE_WEIGHTS[sourceType] ?? 0.5;
}

function groupObservations(observations: Observation[]): GroupedObservations {
  const grouped: GroupedObservations = {};

  for (const obs of observations) {
    if (obs.field === "raw_ocr_text") continue;

    const field = obs.field;
    const value = obs.value.trim().toLowerCase();
    if (!value) continue;

    if (!grouped[field]) grouped[field] = {};
    if (!grouped[field][value]) grouped[field][value] = [];
    grouped[field][value].push(obs);
  }

  return grouped;
}

function fuseField(
  caseId: string,
  field: string,
  valueGroups: { [value: string]: Observation[] },
): Candidate[] {
  const values = Object.keys(valueGroups);
  const hasConflict = values.length > 1;

  const candidates: Candidate[] = [];

  for (const [value, obs] of Object.entries(valueGroups)) {
    const weightedSum = obs.reduce(
      (sum, o) => sum + o.confidence * getSourceWeight(o.source_type),
      0,
    );
    const weightTotal = obs.reduce((sum, o) => sum + getSourceWeight(o.source_type), 0);
    const baseConfidence = weightTotal > 0 ? weightedSum / weightTotal : 0;

    const sourceTypes = new Set(obs.map((o) => o.source_type));
    const corroborationBonus = Math.max(0, (sourceTypes.size - 1) * CORROBORATION_BOOST);

    const hasRegionOcr = obs.some((o) => o.source_type === "ocr" && o.region_type !== null);
    const regionBonus = hasRegionOcr ? 0.04 : 0;

    const contradictionPenalty = hasConflict ? CONTRADICTION_PENALTY : 0;

    const confidence = Math.max(
      0,
      Math.min(1, baseConfidence + corroborationBonus + regionBonus - contradictionPenalty),
    );

    const displayValue =
      obs.sort((a, b) => b.confidence - a.confidence)[0].value;

    candidates.push({
      candidate_id: generateCandidateId(),
      case_id: caseId,
      candidate_type: field,
      value: displayValue,
      rank: 0,
      confidence,
      supporting_obs_ids: obs.map((o) => o.observation_id),
    });
  }

  candidates.sort((a, b) => b.confidence - a.confidence);
  candidates.forEach((c, i) => {
    c.rank = i + 1;
  });

  return candidates;
}

/**
 * Fuses all observations into ranked candidates per field.
 * Uses source-type weighted averaging, corroboration boost,
 * region OCR bonus, and contradiction penalty.
 */
export function fuseObservations(
  caseId: string,
  observations: Observation[],
): Candidate[] {
  const grouped = groupObservations(observations);
  const allCandidates: Candidate[] = [];

  for (const [field, valueGroups] of Object.entries(grouped)) {
    const fieldCandidates = fuseField(caseId, field, valueGroups);
    allCandidates.push(...fieldCandidates);
  }

  return allCandidates;
}
