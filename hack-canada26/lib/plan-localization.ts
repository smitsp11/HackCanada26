import { genai, localizationPlanSchema } from "./gemini";
import { LocalizationPlan, RepairStep } from "./types";

export async function planLocalization(
  step: RepairStep
): Promise<LocalizationPlan> {
  const prompt = `
You are helping convert a repair manual step into a localization plan for a computer vision model.

Your job:
Read the repair step and produce a structured localization plan for the next model.

Rules:
- Focus on the physical part(s) the technician or user should interact with next.
- Make the targetDescription specific enough for a vision model to find in a real photo.
- Use contextObjects to include nearby assemblies/components that help visually identify the target.
- overlayText should be short, action-oriented, and suitable for drawing on an image.
- If multiple tiny parts like screws should be highlighted together, set groupTargets=true.
- Do not return prose. Return only the structured JSON matching the schema.

Repair step:
${JSON.stringify(step, null, 2)}
`.trim();

  const response = await genai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: localizationPlanSchema,
      temperature: 0.1,
    },
  });

  const text = response.text?.trim();

  if (!text) {
    throw new Error("Gemini returned empty response");
  }

  let parsed: LocalizationPlan;
  try {
    parsed = JSON.parse(text) as LocalizationPlan;
  } catch {
    throw new Error("Failed to parse Gemini localization plan JSON");
  }

  return parsed;
}
