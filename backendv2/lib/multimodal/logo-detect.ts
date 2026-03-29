import sharp from "sharp";
import type { Observation } from "./types";
import { generateObservationId } from "./types";
import { getSession, runInference, float32Tensor, getFloat32Output } from "./onnx-inference";
import { logger } from "../observability";

const ONNX_MODEL_NAME = "logo_detector";

const DETECT_INPUT_SIZE = 640;
const CONFIDENCE_THRESHOLD = 0.35;
const NMS_IOU_THRESHOLD = 0.45;

export const BRAND_LABELS = [
  "bosch", "samsung", "lg", "whirlpool", "ge", "maytag", "frigidaire",
  "kitchenaid", "kenmore", "electrolux", "miele", "thermador", "sub_zero",
  "viking", "jenn_air", "amana", "hotpoint", "haier", "fisher_paykel",
  "speed_queen",
] as const;

interface Detection {
  brand: string;
  confidence: number;
  bbox: { x: number; y: number; width: number; height: number };
}

/**
 * Preprocesses an image for YOLOv8 detection: resize with letterbox to 640x640,
 * normalize to [0,1], CHW layout.
 */
async function preprocessForDetection(imageUrl: string): Promise<{
  tensor: Float32Array;
  scaleX: number;
  scaleY: number;
  padX: number;
  padY: number;
} | null> {
  try {
    const res = await fetch(imageUrl);
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());

    const metadata = await sharp(buffer).metadata();
    const origW = metadata.width || DETECT_INPUT_SIZE;
    const origH = metadata.height || DETECT_INPUT_SIZE;

    const scale = Math.min(DETECT_INPUT_SIZE / origW, DETECT_INPUT_SIZE / origH);
    const newW = Math.round(origW * scale);
    const newH = Math.round(origH * scale);
    const padX = Math.round((DETECT_INPUT_SIZE - newW) / 2);
    const padY = Math.round((DETECT_INPUT_SIZE - newH) / 2);

    const { data } = await sharp(buffer)
      .resize(newW, newH, { fit: "fill" })
      .extend({
        top: padY,
        bottom: DETECT_INPUT_SIZE - newH - padY,
        left: padX,
        right: DETECT_INPUT_SIZE - newW - padX,
        background: { r: 114, g: 114, b: 114 },
      })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const pixels = DETECT_INPUT_SIZE * DETECT_INPUT_SIZE;
    const chw = new Float32Array(3 * pixels);
    for (let i = 0; i < pixels; i++) {
      chw[i] = data[i * 3] / 255;
      chw[pixels + i] = data[i * 3 + 1] / 255;
      chw[2 * pixels + i] = data[i * 3 + 2] / 255;
    }

    return { tensor: chw, scaleX: 1 / scale, scaleY: 1 / scale, padX, padY };
  } catch {
    return null;
  }
}

/**
 * Non-maximum suppression on detections sorted by confidence descending.
 */
function nms(detections: Detection[]): Detection[] {
  const sorted = [...detections].sort((a, b) => b.confidence - a.confidence);
  const kept: Detection[] = [];

  for (const det of sorted) {
    let dominated = false;
    for (const kept_det of kept) {
      if (iou(det.bbox, kept_det.bbox) > NMS_IOU_THRESHOLD) {
        dominated = true;
        break;
      }
    }
    if (!dominated) kept.push(det);
  }

  return kept;
}

function iou(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);

  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.width * a.height + b.width * b.height - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Parses raw YOLO output tensor into detections.
 * YOLOv8 output shape: [1, num_classes + 4, num_boxes]
 * Row layout: [x_center, y_center, width, height, class_scores...]
 */
function parseYoloOutput(
  output: Float32Array,
  numBoxes: number,
  padX: number,
  padY: number,
  scaleX: number,
  scaleY: number,
): Detection[] {
  const numClasses = BRAND_LABELS.length;
  const stride = numClasses + 4;
  const detections: Detection[] = [];

  for (let i = 0; i < numBoxes; i++) {
    let bestClass = 0;
    let bestScore = 0;
    for (let c = 0; c < numClasses; c++) {
      const score = output[(4 + c) * numBoxes + i];
      if (score > bestScore) {
        bestScore = score;
        bestClass = c;
      }
    }

    if (bestScore < CONFIDENCE_THRESHOLD) continue;

    const cx = output[0 * numBoxes + i];
    const cy = output[1 * numBoxes + i];
    const w = output[2 * numBoxes + i];
    const h = output[3 * numBoxes + i];

    const x = (cx - w / 2 - padX) * scaleX;
    const y = (cy - h / 2 - padY) * scaleY;

    detections.push({
      brand: BRAND_LABELS[bestClass],
      confidence: bestScore,
      bbox: {
        x: Math.max(0, x),
        y: Math.max(0, y),
        width: w * scaleX,
        height: h * scaleY,
      },
    });
  }

  return detections;
}

/**
 * Detects brand logos in appliance images using a YOLO-based ONNX model.
 * Returns observations with bounding boxes. Returns empty array if model unavailable.
 */
export async function detectLogos(
  caseId: string,
  imageAssets: { asset_id: string; url: string }[],
): Promise<Observation[]> {
  const handle = await getSession(ONNX_MODEL_NAME);
  if (!handle) {
    logger.info("Logo detector model not available, skipping", { case_id: caseId });
    return [];
  }

  const observations: Observation[] = [];

  for (const asset of imageAssets) {
    try {
      const prep = await preprocessForDetection(asset.url);
      if (!prep) continue;

      const input = float32Tensor(prep.tensor, [1, 3, DETECT_INPUT_SIZE, DETECT_INPUT_SIZE]);
      const result = await runInference(handle, { images: input });
      if (!result) continue;

      const outputKey = Object.keys(result)[0];
      const rawOutput = getFloat32Output(result[outputKey]);

      const outputShape = result[outputKey].dims;
      const numBoxes = Number(outputShape[2] || 8400);

      const detections = parseYoloOutput(
        rawOutput, numBoxes,
        prep.padX, prep.padY, prep.scaleX, prep.scaleY,
      );

      const filtered = nms(detections);

      for (const det of filtered) {
        observations.push({
          observation_id: generateObservationId(),
          case_id: caseId,
          asset_id: asset.asset_id,
          source_type: "logo_detector",
          field: "brand",
          value: det.brand,
          confidence: det.confidence,
          region_type: "label",
          metadata: {
            bbox: det.bbox,
            inference_method: "onnx_yolo",
          },
        });
      }
    } catch (e) {
      logger.warn("Logo detection failed for asset", {
        case_id: caseId,
        asset_id: asset.asset_id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  if (observations.length > 0) {
    logger.info("Logo detection completed", {
      case_id: caseId,
      detections: observations.length,
    });
  }

  return observations;
}
