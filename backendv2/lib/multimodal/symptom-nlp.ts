import { genai } from "../gemini";
import { Type } from "@google/genai";
import type { Observation } from "./types";
import { generateObservationId } from "./types";
import { logger } from "../observability";

export const SYMPTOM_TAXONOMY = [
  // Drainage / water
  "not_draining",
  "leaking",
  "standing_water",
  "overflowing",
  "low_water_pressure",
  // Temperature
  "not_heating",
  "not_cooling",
  "overheating",
  "water_too_hot",
  "water_too_cold",
  "inconsistent_temperature",
  "freezing_over",
  "ice_buildup",
  // Noise
  "grinding_noise",
  "excessive_noise",
  "vibrating",
  "clicking_noise",
  "humming_noise",
  "squealing_noise",
  // Power / electrical
  "no_power",
  "won't_start",
  "won't_stop",
  "cycling_on_off",
  "tripping_breaker",
  "flickering_lights",
  // Mechanical
  "not_spinning",
  "door_won't_open",
  "door_won't_close",
  "not_dispensing",
  "not_agitating",
  "drum_not_turning",
  "stuck_cycle",
  // Display / controls
  "error_code_displayed",
  "display_malfunction",
  "unresponsive_controls",
  // Cleaning / drying performance
  "poor_cleaning",
  "not_drying",
  "leaving_residue",
  "spots_on_dishes",
  // Odor
  "strange_smell",
  "burning_smell",
  "gas_smell",
  "mold_smell",
  // HVAC-specific
  "weak_airflow",
  "short_cycling",
  "compressor_not_running",
  "thermostat_issues",
  "ductwork_noise",
  "refrigerant_leak",
  // Water heater-specific
  "pilot_light_out",
  "rusty_water",
  "slow_recovery",
  "tank_leaking",
  // Garbage disposal-specific
  "disposal_jammed",
  "disposal_won't_turn",
  // Cooktop/range-specific
  "burner_won't_ignite",
  "uneven_heating",
  "oven_won't_preheat",
  "self_clean_malfunction",
] as const;

const URGENCY_MAP: Record<string, "high" | "medium" | "low"> = {
  burning_smell: "high",
  gas_smell: "high",
  tripping_breaker: "high",
  overheating: "high",
  refrigerant_leak: "high",
  tank_leaking: "high",
  leaking: "medium",
  no_power: "medium",
  error_code_displayed: "medium",
  pilot_light_out: "medium",
  overflowing: "medium",
  not_draining: "medium",
  not_heating: "medium",
  not_cooling: "medium",
};

const NEGATION_CLEAR = [
  /\bno longer\s+/i,
  /\bnot\s+(?:currently\s+)?/i,
  /\bstopped\s+/i,
  /\bdoesn'?t\s+(?:seem to\s+)?/i,
  /\bisn'?t\s+/i,
  /\bnever\s+/i,
];

const NEGATION_AMBIGUOUS = [
  /\bused to\b/i,
  /\bsometimes\s+doesn'?t\b/i,
  /\boccasionally\s+not\b/i,
  /\bintermittent(?:ly)?\b/i,
  /\bon and off\b/i,
];

function detectNegation(text: string, tag: string): "clear" | "ambiguous" | null {
  const tagWords = tag.replace(/_/g, " ").replace(/'/g, "'");

  for (const pattern of NEGATION_CLEAR) {
    const match = text.match(new RegExp(pattern.source + tagWords, "i"));
    if (match) return "clear";
  }

  for (const pattern of NEGATION_AMBIGUOUS) {
    if (pattern.test(text)) {
      const tagRegex = new RegExp(tagWords, "i");
      if (tagRegex.test(text)) return "ambiguous";
    }
  }

  return null;
}

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

const KEYWORD_MAP: Record<string, string[]> = {
  not_draining: ["not draining", "won't drain", "doesn't drain", "no drain", "drain issue"],
  leaking: ["leak", "leaking", "water on floor", "dripping", "drip"],
  standing_water: ["standing water", "water at bottom", "pooling", "water sitting"],
  overflowing: ["overflow", "overflowing", "spilling over"],
  low_water_pressure: ["low pressure", "weak water", "slow fill"],
  not_heating: ["not heating", "won't heat", "no heat", "cold water"],
  not_cooling: ["not cooling", "won't cool", "warm", "not cold enough"],
  overheating: ["overheating", "too hot", "extremely hot", "scorching"],
  water_too_hot: ["water too hot", "scalding"],
  water_too_cold: ["water too cold", "lukewarm"],
  inconsistent_temperature: ["inconsistent temp", "fluctuating temp", "uneven temp"],
  freezing_over: ["freezing over", "frozen", "frost"],
  ice_buildup: ["ice buildup", "ice build-up", "icing up", "frost buildup"],
  grinding_noise: ["grinding", "grind"],
  excessive_noise: ["loud", "noise", "noisy", "banging", "rattling", "clanking"],
  vibrating: ["vibrat", "shaking", "wobbl"],
  clicking_noise: ["clicking", "click"],
  humming_noise: ["humming", "hum", "buzz"],
  squealing_noise: ["squeal", "screech", "high pitched"],
  no_power: ["no power", "won't turn on", "dead", "no lights"],
  "won't_start": ["won't start", "doesn't start", "not starting"],
  "won't_stop": ["won't stop", "keeps running", "runs continuously"],
  cycling_on_off: ["cycling", "turns on and off", "intermittent"],
  tripping_breaker: ["tripping breaker", "trips breaker", "blows fuse"],
  flickering_lights: ["flickering", "flashing", "blinking light"],
  not_spinning: ["not spinning", "won't spin"],
  "door_won't_open": ["door won't open", "door stuck", "can't open"],
  "door_won't_close": ["door won't close", "won't latch", "door loose"],
  not_dispensing: ["not dispensing", "won't dispense"],
  not_agitating: ["not agitating", "won't agitate"],
  drum_not_turning: ["drum not turning", "drum stuck"],
  stuck_cycle: ["stuck on cycle", "cycle won't finish", "never completes"],
  error_code_displayed: ["error", "error code", "fault code", "display shows", "code"],
  display_malfunction: ["display not working", "screen blank", "display broken"],
  unresponsive_controls: ["buttons not working", "controls unresponsive", "touchpad dead"],
  poor_cleaning: ["not cleaning", "poor clean", "dirty dishes", "still dirty"],
  not_drying: ["not drying", "won't dry", "still wet", "damp"],
  leaving_residue: ["residue", "film", "gritty"],
  spots_on_dishes: ["spots", "spotty", "water marks"],
  strange_smell: ["smell", "odor", "stink"],
  burning_smell: ["burning smell", "burnt", "smoke smell", "electrical smell"],
  gas_smell: ["gas smell", "gas leak", "rotten egg"],
  mold_smell: ["mold", "mildew", "musty"],
  weak_airflow: ["weak airflow", "low air", "barely blowing"],
  short_cycling: ["short cycling", "turns off quickly", "runs briefly"],
  compressor_not_running: ["compressor not running", "compressor won't start"],
  thermostat_issues: ["thermostat", "wrong temperature reading"],
  ductwork_noise: ["duct noise", "ductwork", "rattling duct"],
  refrigerant_leak: ["refrigerant", "freon", "coolant leak"],
  pilot_light_out: ["pilot light", "pilot won't stay", "pilot out"],
  rusty_water: ["rusty water", "brown water", "discolored water"],
  slow_recovery: ["slow recovery", "takes forever to heat", "slow to heat"],
  tank_leaking: ["tank leak", "tank dripping", "water under heater"],
  disposal_jammed: ["disposal jammed", "disposal stuck", "garbage disposal jam"],
  "disposal_won't_turn": ["disposal won't turn", "disposal dead"],
  "burner_won't_ignite": ["burner won't light", "won't ignite", "no flame", "burner won't start"],
  uneven_heating: ["uneven heating", "hot spots", "cold spots", "heats unevenly"],
  "oven_won't_preheat": ["oven won't preheat", "oven not heating"],
  self_clean_malfunction: ["self clean", "self-clean not working"],
};

/**
 * Parses user-provided symptom text into canonical symptom tags using Gemini,
 * with expanded keyword fallback, negation detection, and urgency scoring.
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
          const negation = detectNegation(descriptionRaw, symptom.tag);
          if (negation === "clear") continue;

          if (negation === "ambiguous") {
            // Log for post-launch review — the 0.6 multiplier is a heuristic.
            // Collect real examples to determine if it over-suppresses or under-suppresses.
            logger.info("Ambiguous negation detected", {
              case_id: caseId,
              tag: symptom.tag,
              original_confidence: symptom.confidence,
              reduced_confidence: symptom.confidence * 0.6,
              description_snippet: descriptionRaw.slice(0, 200),
            });
          }

          const urgency = URGENCY_MAP[symptom.tag] || "low";
          observations.push({
            observation_id: generateObservationId(),
            case_id: caseId,
            asset_id: null,
            source_type: "text_parse",
            field: "symptom",
            value: symptom.tag,
            confidence: negation === "ambiguous" ? symptom.confidence * 0.6 : symptom.confidence,
            region_type: null,
            metadata: {
              raw_description: descriptionRaw,
              urgency,
              ...(negation === "ambiguous" && { negation: "ambiguous" }),
            },
          });
        }
      }
    }
  } catch {
    // Gemini symptom extraction failed; fall through to keyword extraction
  }

  if (observations.length === 0) {
    const lower = descriptionRaw.toLowerCase();

    for (const [tag, keywords] of Object.entries(KEYWORD_MAP)) {
      if (keywords.some((kw) => lower.includes(kw))) {
        const negation = detectNegation(descriptionRaw, tag);
        if (negation === "clear") continue;

        if (negation === "ambiguous") {
          logger.info("Ambiguous negation detected (keyword fallback)", {
            case_id: caseId,
            tag,
            description_snippet: descriptionRaw.slice(0, 200),
          });
        }

        const urgency = URGENCY_MAP[tag] || "low";
        observations.push({
          observation_id: generateObservationId(),
          case_id: caseId,
          asset_id: null,
          source_type: "text_parse",
          field: "symptom",
          value: tag,
          confidence: negation === "ambiguous" ? 0.36 : 0.6,
          region_type: null,
          metadata: {
            method: "keyword_fallback",
            urgency,
            ...(negation === "ambiguous" && { negation: "ambiguous" }),
          },
        });
      }
    }
  }

  return observations;
}
