import { GoogleGenAI, Type } from "@google/genai";

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  throw new Error("Missing GEMINI_API_KEY");
}

export const genai = new GoogleGenAI({ apiKey });

export const localizationPlanSchema = {
  type: Type.OBJECT,
  properties: {
    targetLabel: {
      type: Type.STRING,
      description: "Short label for the target part(s), e.g. screws, connector, fuse",
    },
    targetDescription: {
      type: Type.STRING,
      description: "Specific visual description of what the CV model should find",
    },
    countHint: {
      type: Type.INTEGER,
      description: "Number of target parts if explicitly known",
      nullable: true,
    },
    contextObjects: {
      type: Type.ARRAY,
      items: {
        type: Type.STRING,
      },
      description: "Nearby assemblies or objects that help visually identify the target",
    },
    overlayText: {
      type: Type.STRING,
      description: "Short label to show on the final image overlay",
    },
    groupTargets: {
      type: Type.BOOLEAN,
      description: "Whether the later CV model should return one grouped box covering all relevant targets",
    },
  },
  required: [
    "targetLabel",
    "targetDescription",
    "contextObjects",
    "overlayText",
    "groupTargets",
  ],
};

export const localizationResultSchema = {
  type: Type.OBJECT,
  properties: {
    found: { type: Type.BOOLEAN },
    targetLabel: { type: Type.STRING, nullable: true },
    box2d: {
      type: Type.ARRAY,
      items: { type: Type.INTEGER },
      minItems: 4,
      maxItems: 4,
      nullable: true,
    },
  },
  required: ["found"],
};