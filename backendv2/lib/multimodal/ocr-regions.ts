import { extractText } from "../ocr";
import type { Observation } from "./types";
import { generateObservationId } from "./types";

export interface OcrResult {
  asset_id: string;
  text: string;
}

/**
 * Runs full-image OCR on each image URL. Phase 1 does a single pass per image;
 * region-specific passes (label, display, panel) are deferred to Phase 2.
 */
export async function runOcr(
  caseId: string,
  imageAssets: { asset_id: string; url: string }[],
): Promise<{ observations: Observation[]; ocrResults: OcrResult[] }> {
  const observations: Observation[] = [];
  const ocrResults: OcrResult[] = [];

  for (const asset of imageAssets) {
    try {
      const text = await extractText(asset.url);
      const trimmed = text.trim();

      if (trimmed.length > 0) {
        observations.push({
          observation_id: generateObservationId(),
          case_id: caseId,
          asset_id: asset.asset_id,
          source_type: "ocr",
          field: "raw_ocr_text",
          value: trimmed,
          confidence: 0.7,
          region_type: null,
          metadata: { char_count: trimmed.length },
        });

        ocrResults.push({
          asset_id: asset.asset_id,
          text: trimmed,
        });
      }
    } catch {
      observations.push({
        observation_id: generateObservationId(),
        case_id: caseId,
        asset_id: asset.asset_id,
        source_type: "ocr",
        field: "raw_ocr_text",
        value: "",
        confidence: 0,
        region_type: null,
        metadata: { error: true },
      });
    }
  }

  return { observations, ocrResults };
}
