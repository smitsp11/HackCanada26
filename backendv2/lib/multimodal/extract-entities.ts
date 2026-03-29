import { genai } from "../gemini";
import { Type } from "@google/genai";
import { parseProduct } from "../parse-product";
import { lookupProduct } from "../lookup-product";
import type { Observation } from "./types";
import { generateObservationId } from "./types";
import type { OcrResult } from "./ocr-regions";

const entitySchema = {
  type: Type.OBJECT,
  properties: {
    brand: { type: Type.STRING, nullable: true },
    model_number: { type: Type.STRING, nullable: true },
    serial_number: { type: Type.STRING, nullable: true },
    error_codes: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "Error codes found in the text (e.g. E24, F1, OE)",
    },
  },
  required: ["brand", "model_number", "serial_number", "error_codes"],
};

const OCR_SUBSTITUTIONS: [RegExp, string][] = [
  [/O(?=\d)/g, "0"],
  [/(?<=\d)O/g, "0"],
  [/I(?=\d)/g, "1"],
  [/(?<=\d)I/g, "1"],
  [/S(?=\d{2})/g, "5"],
  [/(?<=\d)S(?=\d)/g, "5"],
];

function applyOcrCorrection(text: string): string {
  let corrected = text;
  for (const [pattern, replacement] of OCR_SUBSTITUTIONS) {
    corrected = corrected.replace(pattern, replacement);
  }
  return corrected;
}

interface GeminiEntityResult {
  brand: string | null;
  model_number: string | null;
  serial_number: string | null;
  error_codes: string[];
}

/**
 * Extracts brand, model, serial, and error code entities from OCR text.
 * Uses three sources: Gemini structured extraction, regex parsing, and catalog lookup.
 */
export async function extractEntities(
  caseId: string,
  ocrResults: OcrResult[],
  userMetadata?: { brand?: string; model?: string; error_code?: string },
): Promise<Observation[]> {
  const observations: Observation[] = [];
  const allOcrText = ocrResults.map((r) => r.text).join("\n");

  if (userMetadata?.brand) {
    observations.push({
      observation_id: generateObservationId(),
      case_id: caseId,
      asset_id: null,
      source_type: "user_metadata",
      field: "brand",
      value: userMetadata.brand,
      confidence: 0.7,
      region_type: null,
      metadata: { from_user: true },
    });
  }

  if (userMetadata?.model) {
    observations.push({
      observation_id: generateObservationId(),
      case_id: caseId,
      asset_id: null,
      source_type: "user_metadata",
      field: "model",
      value: userMetadata.model,
      confidence: 0.7,
      region_type: null,
      metadata: { from_user: true },
    });
  }

  if (userMetadata?.error_code) {
    observations.push({
      observation_id: generateObservationId(),
      case_id: caseId,
      asset_id: null,
      source_type: "user_metadata",
      field: "error_code",
      value: userMetadata.error_code,
      confidence: 0.8,
      region_type: null,
      metadata: { from_user: true },
    });
  }

  // Regex-based extraction via parseProduct
  for (const ocr of ocrResults) {
    const regexResult = parseProduct(ocr.text);
    if (regexResult.company) {
      observations.push({
        observation_id: generateObservationId(),
        case_id: caseId,
        asset_id: ocr.asset_id,
        source_type: "text_parse",
        field: "brand",
        value: regexResult.company,
        confidence: 0.75,
        region_type: null,
        metadata: { method: "regex" },
      });
    }
    if (regexResult.modelNumber) {
      observations.push({
        observation_id: generateObservationId(),
        case_id: caseId,
        asset_id: ocr.asset_id,
        source_type: "text_parse",
        field: "model",
        value: regexResult.modelNumber,
        confidence: 0.7,
        region_type: null,
        metadata: { method: "regex", raw: regexResult.modelNumber },
      });

      const corrected = applyOcrCorrection(regexResult.modelNumber);
      if (corrected !== regexResult.modelNumber) {
        observations.push({
          observation_id: generateObservationId(),
          case_id: caseId,
          asset_id: ocr.asset_id,
          source_type: "text_parse",
          field: "model",
          value: corrected,
          confidence: 0.65,
          region_type: null,
          metadata: { method: "ocr_correction", original: regexResult.modelNumber },
        });
      }
    }
  }

  // Gemini structured extraction from combined OCR text
  if (allOcrText.trim().length > 0) {
    try {
      const geminiEntities = await extractWithGemini(allOcrText);

      if (geminiEntities.brand) {
        observations.push({
          observation_id: generateObservationId(),
          case_id: caseId,
          asset_id: null,
          source_type: "gemini",
          field: "brand",
          value: geminiEntities.brand,
          confidence: 0.8,
          region_type: null,
          metadata: { method: "gemini_extraction" },
        });
      }

      if (geminiEntities.model_number) {
        observations.push({
          observation_id: generateObservationId(),
          case_id: caseId,
          asset_id: null,
          source_type: "gemini",
          field: "model",
          value: geminiEntities.model_number,
          confidence: 0.8,
          region_type: null,
          metadata: { method: "gemini_extraction" },
        });
      }

      if (geminiEntities.serial_number) {
        observations.push({
          observation_id: generateObservationId(),
          case_id: caseId,
          asset_id: null,
          source_type: "gemini",
          field: "serial",
          value: geminiEntities.serial_number,
          confidence: 0.75,
          region_type: null,
          metadata: { method: "gemini_extraction" },
        });
      }

      for (const code of geminiEntities.error_codes) {
        observations.push({
          observation_id: generateObservationId(),
          case_id: caseId,
          asset_id: null,
          source_type: "gemini",
          field: "error_code",
          value: code,
          confidence: 0.85,
          region_type: null,
          metadata: { method: "gemini_extraction" },
        });
      }
    } catch {
      // Gemini extraction failed; regex results still available
    }
  }

  // Catalog lookup for model validation
  const modelObs = observations.filter((o) => o.field === "model");
  const brandObs = observations.filter((o) => o.field === "brand");
  const topBrand = brandObs.sort((a, b) => b.confidence - a.confidence)[0]?.value;

  for (const mObs of modelObs) {
    try {
      const product = await lookupProduct(topBrand, mObs.value);
      if (product) {
        observations.push({
          observation_id: generateObservationId(),
          case_id: caseId,
          asset_id: mObs.asset_id,
          source_type: "catalog_lookup",
          field: "model",
          value: product.model_number,
          confidence: 0.95,
          region_type: null,
          metadata: {
            catalog_match: true,
            product_id: product.id,
            display_name: product.display_name,
            product_type: product.product_type,
          },
        });

        if (product.company && !topBrand) {
          observations.push({
            observation_id: generateObservationId(),
            case_id: caseId,
            asset_id: null,
            source_type: "catalog_lookup",
            field: "brand",
            value: product.company,
            confidence: 0.9,
            region_type: null,
            metadata: { from_catalog: true },
          });
        }
        break;
      }
    } catch {
      // catalog lookup failed; continue
    }
  }

  return observations;
}

async function extractWithGemini(ocrText: string): Promise<GeminiEntityResult> {
  const prompt = `You are an expert at reading appliance labels and nameplates. The following text was extracted via OCR from an appliance image. It may contain OCR errors.

Extract the following structured fields:
- brand: The manufacturer/brand name
- model_number: The model number or part number
- serial_number: The serial number
- error_codes: Any error/fault codes displayed (e.g. E24, F1, OE, etc.)

OCR Text:
"""
${ocrText}
"""

Return JSON. Set fields to null if not found. error_codes should be an empty array if none found.`;

  const response = await genai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [prompt],
    config: {
      responseMimeType: "application/json",
      responseSchema: entitySchema,
      temperature: 0.1,
    },
  });

  const text = response.text?.trim();
  if (!text) {
    return { brand: null, model_number: null, serial_number: null, error_codes: [] };
  }

  return JSON.parse(text) as GeminiEntityResult;
}
