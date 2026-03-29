import { genai } from "../gemini";
import { Type } from "@google/genai";
import type { Observation } from "./types";
import { generateObservationId } from "./types";

const classifySchema = {
  type: Type.OBJECT,
  properties: {
    appliance_type: {
      type: Type.STRING,
      description:
        "The primary appliance category, e.g. dishwasher, washer, dryer, refrigerator, oven, microwave, furnace, air_conditioner, water_heater, garbage_disposal",
    },
    confidence: {
      type: Type.NUMBER,
      description: "Confidence score between 0 and 1",
    },
    alternatives: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          label: { type: Type.STRING },
          confidence: { type: Type.NUMBER },
        },
        required: ["label", "confidence"],
      },
      description: "Other possible appliance types with lower confidence",
    },
  },
  required: ["appliance_type", "confidence", "alternatives"],
};

async function imageUrlToInlinePart(imageUrl: string) {
  const res = await fetch(imageUrl);
  if (!res.ok) {
    throw new Error(`Failed to fetch image for classify: ${res.status}`);
  }
  const contentType = res.headers.get("content-type") || "image/jpeg";
  const arrayBuffer = await res.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString("base64");
  return { inlineData: { mimeType: contentType, data: base64 } };
}

export interface ClassifyResult {
  appliance_type: string;
  confidence: number;
  alternatives: { label: string; confidence: number }[];
}

/**
 * Classifies the appliance type from one or more image URLs using Gemini.
 * Returns observations and the structured classify result.
 */
export async function classifyAppliance(
  caseId: string,
  imageUrls: string[],
  applianceHint?: string,
): Promise<{ observations: Observation[]; result: ClassifyResult }> {
  const urls = imageUrls.filter(Boolean);
  if (urls.length === 0) {
    const fallback: ClassifyResult = {
      appliance_type: applianceHint || "unknown",
      confidence: applianceHint ? 0.5 : 0.1,
      alternatives: [],
    };
    return {
      observations: [
        {
          observation_id: generateObservationId(),
          case_id: caseId,
          asset_id: null,
          source_type: "user_metadata",
          field: "appliance_type",
          value: fallback.appliance_type,
          confidence: fallback.confidence,
          region_type: null,
          metadata: { from_hint: true },
        },
      ],
      result: fallback,
    };
  }

  const imageParts = await Promise.all(urls.map(imageUrlToInlinePart));

  const prompt = `You are an appliance classification expert. Look at the provided image(s) of a home appliance.

Classify the appliance into exactly one primary category. Common categories include: dishwasher, washer, dryer, refrigerator, oven, range, microwave, furnace, air_conditioner, water_heater, garbage_disposal, freezer, cooktop, hood, ice_maker.

${applianceHint ? `The user suggested this might be a "${applianceHint}" — use this as a hint but trust what you see in the image(s).` : ""}

Return JSON with the primary classification and any plausible alternatives.`;

  const response = await genai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [prompt, ...imageParts],
    config: {
      responseMimeType: "application/json",
      responseSchema: classifySchema,
      temperature: 0.1,
    },
  });

  const text = response.text?.trim();
  if (!text) {
    const fallback: ClassifyResult = {
      appliance_type: applianceHint || "unknown",
      confidence: applianceHint ? 0.4 : 0.1,
      alternatives: [],
    };
    return {
      observations: [
        {
          observation_id: generateObservationId(),
          case_id: caseId,
          asset_id: null,
          source_type: "classifier",
          field: "appliance_type",
          value: fallback.appliance_type,
          confidence: fallback.confidence,
          region_type: null,
          metadata: { gemini_empty: true },
        },
      ],
      result: fallback,
    };
  }

  const parsed = JSON.parse(text) as ClassifyResult;

  const observations: Observation[] = [
    {
      observation_id: generateObservationId(),
      case_id: caseId,
      asset_id: null,
      source_type: "classifier",
      field: "appliance_type",
      value: parsed.appliance_type,
      confidence: parsed.confidence,
      region_type: null,
      metadata: { alternatives: parsed.alternatives },
    },
  ];

  if (applianceHint) {
    observations.push({
      observation_id: generateObservationId(),
      case_id: caseId,
      asset_id: null,
      source_type: "user_metadata",
      field: "appliance_type",
      value: applianceHint,
      confidence: 0.6,
      region_type: null,
      metadata: { from_hint: true },
    });
  }

  return { observations, result: parsed };
}
