import { genai } from "./gemini";
import { Type } from "@google/genai";

const identifySchema = {
  type: Type.OBJECT,
  properties: {
    company: {
      type: Type.STRING,
      description: "The appliance brand/manufacturer name",
      nullable: true,
    },
    modelNumber: {
      type: Type.STRING,
      description: "The model number or part number",
      nullable: true,
    },
  },
  required: ["company", "modelNumber"],
};

async function imageUrlToInlinePart(imageUrl: string) {
  const res = await fetch(imageUrl);
  if (!res.ok) {
    throw new Error(`Failed to fetch image for Gemini: ${res.status}`);
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

/**
 * Sends the image to Gemini vision and asks it to identify the appliance
 * brand and model number. Returns whatever Gemini can extract.
 */
export async function identifyWithGemini(
  imageUrl: string,
): Promise<{ company?: string; modelNumber?: string }> {
  const imagePart = await imageUrlToInlinePart(imageUrl);

  const prompt = `Look at this image of an appliance or its label/nameplate.
Return only the brand (manufacturer) name and model number if visible.
If you cannot determine one or both, set that field to null.
Return JSON only.`;

  const response = await genai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [prompt, imagePart],
    config: {
      responseMimeType: "application/json",
      responseSchema: identifySchema,
      temperature: 0.1,
    },
  });

  const text = response.text?.trim();
  if (!text) {
    return {};
  }

  try {
    const parsed = JSON.parse(text) as {
      company?: string | null;
      modelNumber?: string | null;
    };
    return {
      company: parsed.company ?? undefined,
      modelNumber: parsed.modelNumber ?? undefined,
    };
  } catch {
    return {};
  }
}
