import type { Observation } from "./types";
import { generateObservationId } from "./types";
import { getSession, runInference, float32Tensor, getFloat32Output, softmax, argmax } from "./onnx-inference";
import { parseWav, computeMelSpectrogram, computeAudioFeatureVector } from "./audio-features";
import { logger } from "../observability";
import { downloadFile } from "../storage";
import pool from "../db";

const ONNX_MODEL_NAME = "audio_anomaly";
const CONFIDENCE_THRESHOLD = 0.40;

export const AUDIO_CLASSES = [
  "normal_operation",
  "grinding_noise",
  "clicking_noise",
  "humming_noise",
  "buzzing_noise",
  "rattling_noise",
  "squealing_noise",
  "banging_noise",
  "water_noise",
  "vibrating",
] as const;

const AUDIO_TO_SYMPTOM_MAP: Record<string, string> = {
  grinding_noise: "grinding_noise",
  clicking_noise: "clicking_noise",
  humming_noise: "humming_noise",
  buzzing_noise: "humming_noise",
  rattling_noise: "excessive_noise",
  squealing_noise: "squealing_noise",
  banging_noise: "excessive_noise",
  water_noise: "leaking",
  vibrating: "vibrating",
};

interface AudioAssetInfo {
  asset_id: string;
  audio_storage_uri: string;
}

/**
 * Retrieves audio asset information for video assets in a case.
 */
async function getAudioAssets(caseId: string): Promise<AudioAssetInfo[]> {
  try {
    const { rows } = await pool.query<{
      asset_id: string;
      audio_storage_uri: string | null;
    }>(
      `SELECT a.asset_id, am.audio_storage_uri
       FROM assets a
       JOIN asset_metadata am ON am.asset_id = a.asset_id
       WHERE a.case_id = $1 AND a.asset_type = 'video' AND am.has_audio = true
         AND am.audio_storage_uri IS NOT NULL`,
      [caseId],
    );
    return rows.map((r) => ({
      asset_id: r.asset_id,
      audio_storage_uri: r.audio_storage_uri!,
    }));
  } catch {
    return [];
  }
}

/**
 * Classifies audio anomalies in video assets for a case.
 * Downloads extracted audio, computes features, runs ONNX inference.
 * Returns observations mapped to symptom taxonomy. Empty if model unavailable.
 */
export async function classifyAudioAnomalies(
  caseId: string,
): Promise<Observation[]> {
  const handle = await getSession(ONNX_MODEL_NAME);
  if (!handle) {
    logger.info("Audio anomaly model not available, skipping", { case_id: caseId });
    return [];
  }

  const audioAssets = await getAudioAssets(caseId);
  if (audioAssets.length === 0) {
    return [];
  }

  const observations: Observation[] = [];

  for (const asset of audioAssets) {
    try {
      const audioBuffer = await downloadFile(asset.audio_storage_uri);
      if (audioBuffer.length <= 44) continue;

      const samples = parseWav(audioBuffer);
      if (samples.length < 16000) {
        logger.info("Audio clip too short for analysis", {
          case_id: caseId,
          asset_id: asset.asset_id,
          samples: samples.length,
        });
        continue;
      }

      const spectrogram = computeMelSpectrogram(samples);
      const features = computeAudioFeatureVector(spectrogram);

      const input = float32Tensor(features, [1, features.length]);
      const result = await runInference(handle, { input });
      if (!result) continue;

      const outputKey = Object.keys(result)[0];
      const logits = getFloat32Output(result[outputKey]);
      const probs = softmax(logits);

      const topIdx = argmax(probs);
      const topClass = AUDIO_CLASSES[topIdx] || "normal_operation";
      const topConf = probs[topIdx];

      if (topClass === "normal_operation") continue;

      const symptomTag = AUDIO_TO_SYMPTOM_MAP[topClass];
      if (!symptomTag) continue;

      if (topConf < CONFIDENCE_THRESHOLD) continue;

      observations.push({
        observation_id: generateObservationId(),
        case_id: caseId,
        asset_id: asset.asset_id,
        source_type: "audio_detector",
        field: "symptom",
        value: symptomTag,
        confidence: topConf,
        region_type: null,
        metadata: {
          audio_class: topClass,
          audio_confidence: topConf,
          all_probs: Object.fromEntries(
            AUDIO_CLASSES.map((cls, i) => [cls, Math.round(probs[i] * 1000) / 1000]),
          ),
          inference_method: "onnx_audio",
          spectrogram_frames: spectrogram.numFrames,
        },
      });

      // Emit additional anomaly detections above threshold
      for (let i = 0; i < AUDIO_CLASSES.length; i++) {
        if (i === topIdx) continue;
        const cls = AUDIO_CLASSES[i];
        if (cls === "normal_operation") continue;
        if (probs[i] < CONFIDENCE_THRESHOLD) continue;

        const mappedSymptom = AUDIO_TO_SYMPTOM_MAP[cls];
        if (!mappedSymptom || mappedSymptom === symptomTag) continue;

        observations.push({
          observation_id: generateObservationId(),
          case_id: caseId,
          asset_id: asset.asset_id,
          source_type: "audio_detector",
          field: "symptom",
          value: mappedSymptom,
          confidence: probs[i],
          region_type: null,
          metadata: {
            audio_class: cls,
            inference_method: "onnx_audio",
          },
        });
      }
    } catch (e) {
      logger.warn("Audio classification failed for asset", {
        case_id: caseId,
        asset_id: asset.asset_id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  if (observations.length > 0) {
    logger.info("Audio anomaly detection completed", {
      case_id: caseId,
      detections: observations.length,
    });
  }

  return observations;
}
