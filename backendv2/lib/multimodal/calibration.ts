import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../observability";
import type { SourceType, ObservationField } from "./types";

const CALIBRATION_DIR = join(process.cwd(), "ml", "models", "calibration");

/**
 * Platt scaling parameters: logistic sigmoid P(correct) = 1 / (1 + exp(A*s + B))
 * where s is the raw confidence score.
 */
interface PlattParams {
  A: number;
  B: number;
}

/**
 * Isotonic regression: a sorted list of (threshold, calibrated_value) pairs.
 * For input s, find the bin where threshold_i <= s < threshold_{i+1} and return the value.
 */
interface IsotonicParams {
  thresholds: number[];
  values: number[];
}

interface CalibrationEntry {
  method: "platt" | "isotonic";
  platt?: PlattParams;
  isotonic?: IsotonicParams;
  sample_count: number;
  ece_before: number;
  ece_after: number;
}

type CalibrationKey = string;

function makeKey(sourceType: string, field: string): CalibrationKey {
  return `${sourceType}_${field}`;
}

const calibrationCache = new Map<CalibrationKey, CalibrationEntry | null>();
let cacheLoaded = false;

/**
 * Loads all calibration parameter files from the calibration directory.
 */
async function loadCalibrationParams(): Promise<void> {
  if (cacheLoaded) return;
  cacheLoaded = true;

  if (!existsSync(CALIBRATION_DIR)) {
    logger.info("No calibration directory found, using raw confidence");
    return;
  }

  const allSources: SourceType[] = [
    "ocr", "classifier", "gemini", "text_parse", "catalog_lookup",
    "user_metadata", "logo_detector", "panel_similarity", "audio_detector",
  ];
  const allFields: ObservationField[] = [
    "appliance_type", "brand", "model", "serial", "error_code", "symptom",
  ];

  for (const source of allSources) {
    for (const field of allFields) {
      const key = makeKey(source, field);
      const filePath = join(CALIBRATION_DIR, `${key}.json`);
      if (existsSync(filePath)) {
        try {
          const raw = await readFile(filePath, "utf-8");
          const entry = JSON.parse(raw) as CalibrationEntry;
          calibrationCache.set(key, entry);
        } catch (e) {
          logger.warn("Failed to load calibration params", {
            key,
            error: e instanceof Error ? e.message : String(e),
          });
          calibrationCache.set(key, null);
        }
      }
    }
  }

  const loaded = [...calibrationCache.entries()].filter(([, v]) => v !== null).length;
  if (loaded > 0) {
    logger.info("Loaded calibration parameters", { count: loaded });
  }
}

function applyPlatt(score: number, params: PlattParams): number {
  return 1 / (1 + Math.exp(params.A * score + params.B));
}

function applyIsotonic(score: number, params: IsotonicParams): number {
  const { thresholds, values } = params;
  if (thresholds.length === 0) return score;

  if (score <= thresholds[0]) return values[0];
  if (score >= thresholds[thresholds.length - 1]) return values[values.length - 1];

  for (let i = 0; i < thresholds.length - 1; i++) {
    if (score >= thresholds[i] && score < thresholds[i + 1]) {
      return values[i];
    }
  }

  return values[values.length - 1];
}

/**
 * Calibrates a raw confidence score using pre-trained calibration parameters.
 * Returns the calibrated probability if parameters are available for the given
 * (source_type, field) pair, otherwise returns the raw score unchanged.
 */
export async function calibrate(
  sourceType: string,
  field: string,
  rawConfidence: number,
): Promise<number> {
  await loadCalibrationParams();

  const key = makeKey(sourceType, field);
  const entry = calibrationCache.get(key);
  if (!entry) return rawConfidence;

  let calibrated: number;
  if (entry.method === "platt" && entry.platt) {
    calibrated = applyPlatt(rawConfidence, entry.platt);
  } else if (entry.method === "isotonic" && entry.isotonic) {
    calibrated = applyIsotonic(rawConfidence, entry.isotonic);
  } else {
    return rawConfidence;
  }

  return Math.max(0, Math.min(1, calibrated));
}

/**
 * Returns true if calibration data is available for any source/field pair.
 */
export async function hasCalibrationData(): Promise<boolean> {
  await loadCalibrationParams();
  return [...calibrationCache.values()].some((v) => v !== null);
}

/**
 * Reloads calibration parameters from disk (call after model re-training).
 */
export function reloadCalibration(): void {
  calibrationCache.clear();
  cacheLoaded = false;
}
