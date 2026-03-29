import sharp from "sharp";
import { extractText } from "../ocr";
import { genai } from "../gemini";
import { Type } from "@google/genai";
import type { Observation, RegionType } from "./types";
import { generateObservationId } from "./types";
import { logger } from "../observability";

export interface OcrResult {
  asset_id: string;
  text: string;
}

interface RegionProposal {
  region_type: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const regionSchema = {
  type: Type.OBJECT,
  properties: {
    regions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          region_type: {
            type: Type.STRING,
            description:
              "One of: model_plate, display, panel, label",
          },
          x: { type: Type.INTEGER, description: "Left edge in pixels" },
          y: { type: Type.INTEGER, description: "Top edge in pixels" },
          width: { type: Type.INTEGER, description: "Width in pixels" },
          height: { type: Type.INTEGER, description: "Height in pixels" },
        },
        required: ["region_type", "x", "y", "width", "height"],
      },
    },
  },
  required: ["regions"],
};

const REGION_OCR_TIMEOUT_MS = 5000;
const REGION_OCR_CONFIDENCE = 0.80;
const FULL_IMAGE_OCR_CONFIDENCE = 0.70;
const VALID_REGIONS: RegionType[] = ["model_plate", "display", "panel", "label"];

async function imageUrlToInlinePart(imageUrl: string) {
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
  const contentType = res.headers.get("content-type") || "image/jpeg";
  const arrayBuffer = await res.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString("base64");
  return {
    inlineData: { mimeType: contentType, data: base64 },
    buffer: Buffer.from(arrayBuffer),
  };
}

async function proposeRegions(
  imageBuffer: Buffer,
  imageBase64Part: { inlineData: { mimeType: string; data: string } },
): Promise<RegionProposal[]> {
  const prompt = `You are an appliance image analyzer. Look at this image of a home appliance and identify regions that contain text worth reading via OCR.

Return bounding boxes for any of these region types you can find:
- model_plate: A nameplate, rating plate, or sticker with model/serial numbers
- display: An LED/LCD display showing error codes or status
- panel: A control panel with printed labels or buttons with text
- label: Any other sticker, badge, or printed text (brand logos, warning labels)

Return pixel coordinates relative to the full image. Only return regions you can actually see.`;

  const response = await genai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [prompt, imageBase64Part],
    config: {
      responseMimeType: "application/json",
      responseSchema: regionSchema,
      temperature: 0.1,
    },
  });

  const text = response.text?.trim();
  if (!text) return [];

  const parsed = JSON.parse(text) as { regions: RegionProposal[] };
  return parsed.regions.filter(
    (r) => VALID_REGIONS.includes(r.region_type as RegionType) && r.width > 10 && r.height > 10,
  );
}

async function cropAndOcr(
  imageBuffer: Buffer,
  region: RegionProposal,
): Promise<string> {
  const metadata = await sharp(imageBuffer).metadata();
  const imgW = metadata.width || 1;
  const imgH = metadata.height || 1;

  const left = Math.max(0, Math.min(region.x, imgW - 1));
  const top = Math.max(0, Math.min(region.y, imgH - 1));
  const width = Math.min(region.width, imgW - left);
  const height = Math.min(region.height, imgH - top);

  if (width < 5 || height < 5) return "";

  const cropped = await sharp(imageBuffer)
    .extract({ left, top, width, height })
    .sharpen()
    .normalize()
    .toBuffer();

  return extractTextFromBuffer(cropped);
}

/**
 * Runs Tesseract OCR on a raw image buffer.
 */
export async function extractTextFromBuffer(buffer: Buffer): Promise<string> {
  const Tesseract = await import("tesseract.js");
  const { data } = await Tesseract.default.recognize(buffer, "eng", {
    logger: () => {},
  });
  return data.text;
}

/**
 * Runs OCR on each image asset. Full-image Tesseract and Gemini region proposal
 * execute in parallel. Region-specific OCR runs on proposed crops if available.
 */
export async function runOcr(
  caseId: string,
  imageAssets: { asset_id: string; url: string }[],
): Promise<{ observations: Observation[]; ocrResults: OcrResult[] }> {
  const observations: Observation[] = [];
  const ocrResults: OcrResult[] = [];

  for (const asset of imageAssets) {
    try {
      const { inlineData, buffer: imageBuffer } = await imageUrlToInlinePart(asset.url);

      const fullImagePromise = extractText(asset.url);
      const regionPromise = proposeRegions(imageBuffer, { inlineData })
        .catch((e) => {
          logger.warn("Region proposal failed, using full-image only", {
            case_id: caseId,
            asset_id: asset.asset_id,
            error: e instanceof Error ? e.message : String(e),
          });
          return [] as RegionProposal[];
        });

      const [fullText, regions] = await Promise.all([fullImagePromise, regionPromise]);
      const trimmedFull = fullText.trim();

      if (trimmedFull.length > 0) {
        observations.push({
          observation_id: generateObservationId(),
          case_id: caseId,
          asset_id: asset.asset_id,
          source_type: "ocr",
          field: "raw_ocr_text",
          value: trimmedFull,
          confidence: FULL_IMAGE_OCR_CONFIDENCE,
          region_type: null,
          metadata: { char_count: trimmedFull.length, method: "full_image" },
        });
        ocrResults.push({ asset_id: asset.asset_id, text: trimmedFull });
      }

      if (regions.length > 0) {
        const regionStart = Date.now();

        for (const region of regions) {
          if (Date.now() - regionStart > REGION_OCR_TIMEOUT_MS) {
            logger.warn("Region OCR timeout, skipping remaining regions", {
              case_id: caseId,
              asset_id: asset.asset_id,
              processed: regions.indexOf(region),
              total: regions.length,
            });
            observations.push({
              observation_id: generateObservationId(),
              case_id: caseId,
              asset_id: asset.asset_id,
              source_type: "ocr",
              field: "raw_ocr_text",
              value: "",
              confidence: 0,
              region_type: null,
              metadata: { timeout: true, method: "region_ocr" },
            });
            break;
          }

          try {
            const regionText = await cropAndOcr(imageBuffer, region);
            const trimmedRegion = regionText.trim();

            if (trimmedRegion.length > 0) {
              const regionType = region.region_type as RegionType;
              observations.push({
                observation_id: generateObservationId(),
                case_id: caseId,
                asset_id: asset.asset_id,
                source_type: "ocr",
                field: "raw_ocr_text",
                value: trimmedRegion,
                confidence: REGION_OCR_CONFIDENCE,
                region_type: regionType,
                metadata: {
                  char_count: trimmedRegion.length,
                  method: "region_ocr",
                  bbox: { x: region.x, y: region.y, w: region.width, h: region.height },
                },
              });
              ocrResults.push({ asset_id: asset.asset_id, text: trimmedRegion });
            }
          } catch {
            // Individual region crop/OCR failure; continue with others
          }
        }
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
