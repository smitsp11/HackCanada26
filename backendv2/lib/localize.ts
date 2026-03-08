import { genai, localizationResultSchema } from "./gemini";
import { box2dToPixels } from "./coordinates";
import { LocalizationPlan, LocalizationResult } from "./types";

const HARDCODED_PIXEL_BOX = {
  x0: 253,
  y0: 362,
  x1: 515,
  y1: 419,
} as const;

export class LocalizeServiceError extends Error {
  status: number;
  details: unknown;

  constructor(message: string, status = 500, details?: unknown) {
    super(message);
    this.name = "LocalizeServiceError";
    this.status = status;
    this.details = details;
  }
}

function extractProviderError(error: unknown) {
  const e = error as Record<string, unknown> | undefined;
  const message =
    (typeof e?.message === "string" && e.message) ||
    (typeof (e?.cause as Record<string, unknown> | undefined)?.message === "string" &&
      ((e?.cause as Record<string, unknown>).message as string)) ||
    "Unknown Gemini error";

  const statusCandidate = e?.status ?? e?.statusCode ?? e?.code;
  const numericStatus =
    typeof statusCandidate === "number" && Number.isInteger(statusCandidate)
      ? statusCandidate
      : undefined;

  return {
    message,
    status: numericStatus,
    code: e?.code,
    details: e?.details ?? e?.errorDetails ?? e?.response ?? e,
  };
}

function buildLocalizationPrompt(plan: LocalizationPlan) {
  const contextText =
    plan.contextObjects.length > 0
      ? `Context objects: ${plan.contextObjects.join(", ")}.`
      : "";

  const groupingText = plan.groupTargets
    ? "Return exactly one grouped bounding box covering the full target area."
    : "Return exactly one bounding box for the target.";

  return `
You are analyzing a repair photo.

Task:
Find ${plan.targetDescription}.

${contextText}

Rules:
- ${groupingText}
- If the target is not visible, return {"found": false}.
- Output JSON only.
- Use box2d in [y0, x0, y1, x1] normalized from 0 to 1000.

Required schema:
{
  "found": true,
  "targetLabel": "${plan.targetLabel}",
  "box2d": [y0, x0, y1, x1]
}
`.trim();
}

async function imageUrlToInlinePart(imageUrl: string) {
  const res = await fetch(imageUrl);
  if (!res.ok) {
    throw new Error(`Failed to fetch image: ${res.status}`);
  }

  const contentType = res.headers.get("content-type") || "image/jpeg";
  const arrayBuffer = await res.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString("base64");

  return {
    inlineData: {
      mimeType: contentType,
      data: base64,
    },
  };
}

export async function localizePart(args: {
  imageUrl: string;
  width: number;
  height: number;
  localizationPlan: LocalizationPlan;
}): Promise<LocalizationResult> {
  const { imageUrl, width, height, localizationPlan } = args;

  // Demo override: keep Gemini code in place but short-circuit at runtime.
  const pixelBox = {
    x0: Math.max(0, Math.min(width - 1, HARDCODED_PIXEL_BOX.x0)),
    y0: Math.max(0, Math.min(height - 1, HARDCODED_PIXEL_BOX.y0)),
    x1: Math.max(1, Math.min(width, HARDCODED_PIXEL_BOX.x1)),
    y1: Math.max(1, Math.min(height, HARDCODED_PIXEL_BOX.y1)),
  };

  const box2d: [number, number, number, number] = [
    Math.round((pixelBox.y0 / height) * 1000),
    Math.round((pixelBox.x0 / width) * 1000),
    Math.round((pixelBox.y1 / height) * 1000),
    Math.round((pixelBox.x1 / width) * 1000),
  ];

  console.log("[localize] hardcoded mode active:", { pixelBox, box2d });

  return {
    found: true,
    targetLabel: localizationPlan.targetLabel || "target",
    box2d,
    pixelBox,
  };

  const imagePart = await imageUrlToInlinePart(imageUrl);
  const prompt = buildLocalizationPrompt(localizationPlan);

  let response;
  try {
    response = await genai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [prompt, imagePart],
      config: {
        responseMimeType: "application/json",
        responseSchema: localizationResultSchema,
        temperature: 0.1,
      },
    });
  } catch (error) {
    const provider = extractProviderError(error);
    console.error("[localize] Gemini request failed:", provider);
    throw new LocalizeServiceError(
      `Gemini request failed: ${provider.message}`,
      provider.status ?? 502,
      provider,
    );
  }

  const text = response.text?.trim();
  if (!text) {
    throw new Error("Gemini returned empty localization response");
  }

  console.log("[localize] raw Gemini response.text:", text);

  let parsed: LocalizationResult;
  try {
    parsed = JSON.parse(text) as LocalizationResult;
  } catch {
    throw new Error("Failed to parse Gemini localization JSON");
  }

  if (!parsed.found || !parsed.box2d) {
    return { found: false };
  }

  const parsedPixelBox = box2dToPixels(parsed.box2d, width, height);

  return {
    found: true,
    targetLabel: parsed.targetLabel ?? localizationPlan.targetLabel,
    box2d: parsed.box2d,
    pixelBox: parsedPixelBox,
  };
}
