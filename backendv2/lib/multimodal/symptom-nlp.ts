import { genai } from "../gemini";
import { Type } from "@google/genai";
import type { Observation } from "./types";
import { generateObservationId } from "./types";

export const SYMPTOM_TAXONOMY = [
  "not_draining",
  "leaking",
  "not_heating",
  "not_cooling",
  "grinding_noise",
  "excessive_noise",
  "vibrating",
  "no_power",
  "won't_start",
  "won't_stop",
  "error_code_displayed",
  "standing_water",
  "strange_smell",
  "burning_smell",
  "ice_buildup",
  "not_spinning",
  "door_won't_open",
  "door_won't_close",
  "not_dispensing",
  "overheating",
  "tripping_breaker",
  "water_too_hot",
  "water_too_cold",
  "poor_cleaning",
  "not_drying",
  "cycling_on_off",
  "display_malfunction",
  "gas_smell",
] as const;

const symptomSchema = {
  type: Type.OBJECT,
  properties: {
    symptoms: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          tag: {
            type: Type.STRING,
            description: `One of the canonical symptom tags: ${SYMPTOM_TAXONOMY.join(", ")}`,
          },
          confidence: {
            type: Type.NUMBER,
            description: "Confidence 0-1 that this symptom matches the user description",
          },
        },
        required: ["tag", "confidence"],
      },
    },
  },
  required: ["symptoms"],
};

interface GeminiSymptomResult {
  symptoms: { tag: string; confidence: number }[];
}

/**
 * Parses user-provided symptom text into canonical symptom tags using Gemini.
 */
export async function extractSymptoms(
  caseId: string,
  descriptionRaw: string,
): Promise<Observation[]> {
  if (!descriptionRaw?.trim()) {
    return [];
  }

  const observations: Observation[] = [];

  try {
    const prompt = `You are an appliance repair symptom classifier. Given the user's description of their appliance problem, map it to one or more canonical symptom tags from this list:

${SYMPTOM_TAXONOMY.join(", ")}

User description: "${descriptionRaw}"

Return JSON with a "symptoms" array. Each element has a "tag" (must be from the list above) and a "confidence" (0-1). Only include symptoms with confidence >= 0.3. Order by confidence descending.`;

    const response = await genai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [prompt],
      config: {
        responseMimeType: "application/json",
        responseSchema: symptomSchema,
        temperature: 0.1,
      },
    });

    const text = response.text?.trim();
    if (text) {
      const parsed = JSON.parse(text) as GeminiSymptomResult;

      for (const symptom of parsed.symptoms) {
        if (symptom.confidence >= 0.3) {
          observations.push({
            observation_id: generateObservationId(),
            case_id: caseId,
            asset_id: null,
            source_type: "text_parse",
            field: "symptom",
            value: symptom.tag,
            confidence: symptom.confidence,
            region_type: null,
            metadata: { raw_description: descriptionRaw },
          });
        }
      }
    }
  } catch {
    // Gemini symptom extraction failed; fall through to basic extraction
  }

  // Fallback: basic keyword matching if Gemini returned nothing
  if (observations.length === 0) {
    const lower = descriptionRaw.toLowerCase();
    const keywordMap: Record<string, string[]> = {
      not_draining: ["not draining", "won't drain", "doesn't drain", "no drain"],
      leaking: ["leak", "leaking", "water on floor", "dripping"],
      not_heating: ["not heating", "won't heat", "no heat", "cold"],
      grinding_noise: ["grinding", "grind"],
      excessive_noise: ["loud", "noise", "noisy", "banging", "rattling"],
      no_power: ["no power", "won't turn on", "dead", "no lights"],
      standing_water: ["standing water", "water at bottom", "pooling"],
      error_code_displayed: ["error", "error code", "fault code", "display shows"],
      strange_smell: ["smell", "odor", "stink"],
      not_spinning: ["not spinning", "won't spin"],
    };

    for (const [tag, keywords] of Object.entries(keywordMap)) {
      if (keywords.some((kw) => lower.includes(kw))) {
        observations.push({
          observation_id: generateObservationId(),
          case_id: caseId,
          asset_id: null,
          source_type: "text_parse",
          field: "symptom",
          value: tag,
          confidence: 0.6,
          region_type: null,
          metadata: { method: "keyword_fallback" },
        });
      }
    }
  }

  return observations;
}
