import sharp from "sharp";
import { genai } from "../gemini";
import { Type } from "@google/genai";
import type { Observation } from "./types";
import { generateObservationId } from "./types";
import { getSession, runInference, float32Tensor, softmax, argmax, getFloat32Output } from "./onnx-inference";
import { logger } from "../observability";

const ONNX_MODEL_NAME = "appliance_classifier";

const ONNX_INPUT_SIZE = 224;

export const APPLIANCE_TAXONOMY = [
  "dishwasher", "washer", "dryer", "refrigerator", "oven", "range",
  "microwave", "furnace", "air_conditioner", "water_heater",
  "garbage_disposal", "freezer", "cooktop", "hood", "ice_maker",
] as const;

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

/**
 * Preprocesses an image URL into a CHW float32 tensor normalized to ImageNet stats.
 * Returns null if the image can't be fetched or decoded.
 */
async function preprocessImageForOnnx(imageUrl: string): Promise<Float32Array | null> {
  try {
    const res = await fetch(imageUrl);
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());

    const { data } = await sharp(buffer)
      .resize(ONNX_INPUT_SIZE, ONNX_INPUT_SIZE, { fit: "cover" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const mean = [0.485, 0.456, 0.406];
    const std = [0.229, 0.224, 0.225];
    const pixels = ONNX_INPUT_SIZE * ONNX_INPUT_SIZE;
    const chw = new Float32Array(3 * pixels);

    for (let i = 0; i < pixels; i++) {
      chw[i] = (data[i * 3] / 255 - mean[0]) / std[0];
      chw[pixels + i] = (data[i * 3 + 1] / 255 - mean[1]) / std[1];
      chw[2 * pixels + i] = (data[i * 3 + 2] / 255 - mean[2]) / std[2];
    }
    return chw;
  } catch {
    return null;
  }
}

export interface ClassifyResult {
  appliance_type: string;
  confidence: number;
  alternatives: { label: string; confidence: number }[];
}

/**
 * Attempts ONNX-based classification. Returns null if model unavailable.
 */
async function classifyWithOnnx(imageUrls: string[]): Promise<ClassifyResult | null> {
  const handle = await getSession(ONNX_MODEL_NAME);
  if (!handle) return null;

  const tensors = await Promise.all(imageUrls.map(preprocessImageForOnnx));
  const validTensors = tensors.filter((t): t is Float32Array => t !== null);
  if (validTensors.length === 0) return null;

  const aggregated = new Array(APPLIANCE_TAXONOMY.length).fill(0);
  let count = 0;

  for (const chw of validTensors) {
    const input = float32Tensor(chw, [1, 3, ONNX_INPUT_SIZE, ONNX_INPUT_SIZE]);
    const output = await runInference(handle, { input });
    if (!output) continue;

    const outputKey = Object.keys(output)[0];
    const logits = getFloat32Output(output[outputKey]);
    const probs = softmax(logits);

    for (let i = 0; i < probs.length && i < APPLIANCE_TAXONOMY.length; i++) {
      aggregated[i] += probs[i];
    }
    count++;
  }

  if (count === 0) return null;

  const avgProbs = aggregated.map((s: number) => s / count);
  const topIdx = argmax(avgProbs);
  const topLabel = APPLIANCE_TAXONOMY[topIdx] || "unknown";
  const topConf = avgProbs[topIdx];

  const alternatives = avgProbs
    .map((conf: number, idx: number) => ({ label: APPLIANCE_TAXONOMY[idx], confidence: conf }))
    .filter((_: { label: string; confidence: number }, idx: number) => idx !== topIdx && avgProbs[idx] > 0.02)
    .sort((a: { confidence: number }, b: { confidence: number }) => b.confidence - a.confidence)
    .slice(0, 3);

  logger.info("ONNX classify completed", {
    model: ONNX_MODEL_NAME,
    top: topLabel,
    confidence: topConf,
    images: count,
  });

  return { appliance_type: topLabel, confidence: topConf, alternatives };
}

/**
 * Classifies via Gemini API (original implementation, now used as fallback).
 */
async function classifyWithGemini(
  imageUrls: string[],
  applianceHint?: string,
): Promise<ClassifyResult | null> {
  const imageParts = await Promise.all(imageUrls.map(imageUrlToInlinePart));

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
  if (!text) return null;
  return JSON.parse(text) as ClassifyResult;
}

/**
 * Classifies the appliance type from one or more image URLs.
 * Tries ONNX local model first, falls back to Gemini API.
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

  let parsed: ClassifyResult | null = null;
  let inferenceMethod = "onnx";

  parsed = await classifyWithOnnx(urls);

  if (!parsed) {
    inferenceMethod = "gemini";
    try {
      parsed = await classifyWithGemini(urls, applianceHint);
    } catch (e) {
      logger.warn("Gemini classify fallback failed", {
        case_id: caseId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  if (!parsed) {
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
          metadata: { gemini_empty: true, onnx_unavailable: true },
        },
      ],
      result: fallback,
    };
  }

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
      metadata: { alternatives: parsed.alternatives, inference_method: inferenceMethod },
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
