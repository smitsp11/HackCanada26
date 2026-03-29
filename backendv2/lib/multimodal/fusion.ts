import type { Observation, Candidate } from "./types";
import { generateCandidateId } from "./types";

interface GroupedObservations {
  [field: string]: { [value: string]: Observation[] };
}

/**
 * Groups observations by field, then by normalized value.
 * Multiple sources agreeing on the same value boost confidence;
 * conflicting values within a field get a penalty.
 */
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

const CORROBORATION_BOOST = 0.08;
const CONTRADICTION_PENALTY = 0.1;

function fuseField(
  caseId: string,
  field: string,
  valueGroups: { [value: string]: Observation[] },
): Candidate[] {
  const values = Object.keys(valueGroups);
  const hasConflict = values.length > 1;

  const candidates: Candidate[] = [];

  for (const [value, obs] of Object.entries(valueGroups)) {
    const baseConfidence =
      obs.reduce((sum, o) => sum + o.confidence, 0) / obs.length;

    const sourceTypes = new Set(obs.map((o) => o.source_type));
    const corroborationBonus = Math.max(0, (sourceTypes.size - 1) * CORROBORATION_BOOST);

    const contradictionPenalty = hasConflict ? CONTRADICTION_PENALTY : 0;

    const confidence = Math.max(
      0,
      Math.min(1, baseConfidence + corroborationBonus - contradictionPenalty),
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
 * Groups by field and value, scores corroboration, penalizes contradiction.
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
