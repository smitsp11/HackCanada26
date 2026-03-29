import { genai } from "./gemini";
import { Type } from "@google/genai";

async function imageUrlToInlinePart(imageUrl: string) {
  const res = await fetch(imageUrl);
  if (!res.ok) {
    throw new Error(`Failed to fetch image for Gemini: ${res.status}`);
  }
  const contentType = res.headers.get("content-type") || "image/jpeg";
  const arrayBuffer = await res.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString("base64");
  return { inlineData: { mimeType: contentType, data: base64 } };
}

// ── Diagnosis schema ────────────────────────────────────────────────────────

const diagnosisSchema = {
  type: Type.OBJECT,
  properties: {
    makeModel: {
      type: Type.STRING,
      description: "Identified appliance make and model, e.g. 'Bosch SHP878ZD5N'",
    },
    manualId: {
      type: Type.STRING,
      description: "Best-guess service manual identifier or part number for the appliance",
      nullable: true,
    },
    manualTitle: {
      type: Type.STRING,
      description: "Descriptive title for the service manual or reference document",
    },
    symptomSummary: {
      type: Type.STRING,
      description: "Matched symptom description based on the user input",
    },
    relevantSections: {
      type: Type.STRING,
      description: "Key manual sections relevant to the diagnosed issue, e.g. 'Troubleshooting (p.34) • Drain system (p.67)'",
    },
    partsNeeded: {
      type: Type.STRING,
      description: "List of parts likely needed for repair with availability notes",
    },
  },
  required: [
    "makeModel",
    "manualTitle",
    "symptomSummary",
    "relevantSections",
    "partsNeeded",
  ],
};

export interface DiagnosisResult {
  makeModel: string;
  manualId?: string;
  manualTitle: string;
  symptomSummary: string;
  relevantSections: string;
  partsNeeded: string;
}

export async function diagnoseWithGemini(
  imageUrls: string[],
  symptom: string,
  deviceHint?: string,
): Promise<DiagnosisResult> {
  const imageParts = await Promise.all(
    imageUrls.filter(Boolean).map(imageUrlToInlinePart),
  );

  const prompt = `You are an expert appliance repair diagnostician. You are given images of a home appliance (possibly its nameplate, the issue area, and/or a video thumbnail) along with a user-described symptom.

Symptom: "${symptom}"
${deviceHint ? `Device hint: ${deviceHint}` : ""}

Analyze the images and symptom to produce a structured diagnosis:
1. Identify the appliance make and model from the images.
2. Suggest the most relevant service manual reference.
3. Summarize the matched symptom.
4. List the relevant manual sections for this issue.
5. List parts likely needed for repair with availability estimates.

Return JSON only.`;

  const response = await genai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [prompt, ...imageParts],
    config: {
      responseMimeType: "application/json",
      responseSchema: diagnosisSchema,
      temperature: 0.2,
    },
  });

  const text = response.text?.trim();
  if (!text) {
    throw new Error("Gemini returned empty diagnosis response");
  }

  return JSON.parse(text) as DiagnosisResult;
}

// ── Repair step synthesis schema ────────────────────────────────────────────

const repairStepSchema = {
  type: Type.OBJECT,
  properties: {
    steps: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.INTEGER, description: "Step number starting from 1" },
          instruction: {
            type: Type.STRING,
            description: "Detailed repair instruction for this step",
          },
        },
        required: ["id", "instruction"],
      },
    },
  },
  required: ["steps"],
};

export interface SynthesizedStep {
  id: number;
  instruction: string;
  schematicUrl: string | null;
}

export async function synthesizeRepairSteps(
  imageUrls: string[],
  symptom: string,
  diagnosis: DiagnosisResult,
): Promise<SynthesizedStep[]> {
  const imageParts = await Promise.all(
    imageUrls.filter(Boolean).map(imageUrlToInlinePart),
  );

  const prompt = `You are an expert appliance repair technician. Based on the following diagnosis, generate step-by-step repair instructions.

Appliance: ${diagnosis.makeModel}
Symptom: "${symptom}"
Relevant sections: ${diagnosis.relevantSections}
Parts needed: ${diagnosis.partsNeeded}

Generate detailed, safety-conscious repair steps. Start with safety precautions (turn off power/gas), then proceed through disassembly, inspection, repair/replacement, reassembly, and verification. Each step should be specific and actionable.

Return JSON with a "steps" array where each step has an integer "id" (starting from 1) and a string "instruction".`;

  const response = await genai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [prompt, ...imageParts],
    config: {
      responseMimeType: "application/json",
      responseSchema: repairStepSchema,
      temperature: 0.2,
    },
  });

  const text = response.text?.trim();
  if (!text) {
    throw new Error("Gemini returned empty synthesis response");
  }

  const parsed = JSON.parse(text) as { steps: { id: number; instruction: string }[] };

  return parsed.steps.map((s) => ({
    id: s.id,
    instruction: s.instruction,
    schematicUrl: null,
  }));
}
