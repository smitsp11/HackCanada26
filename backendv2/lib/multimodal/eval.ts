import pool from "../db";
import { logger } from "../observability";

interface LabeledObservation {
  observation_id: string;
  case_id: string;
  source_type: string;
  field: string;
  value: string;
  confidence: number;
  verified_value: string;
}

interface EvalMetrics {
  accuracy: number;
  precision: number;
  recall: number;
  f1: number;
  ece: number;
  mce: number;
  sample_count: number;
  per_field: Record<string, { accuracy: number; f1: number; ece: number; count: number }>;
  per_source: Record<string, { accuracy: number; f1: number; ece: number; count: number }>;
  calibration_bins: CalibrationBin[];
}

interface CalibrationBin {
  bin_start: number;
  bin_end: number;
  avg_confidence: number;
  avg_accuracy: number;
  count: number;
}

const NUM_CALIBRATION_BINS = 10;

/**
 * Fetches labeled observations from the database for evaluation.
 */
async function fetchLabeledData(): Promise<LabeledObservation[]> {
  const { rows } = await pool.query<LabeledObservation>(`
    SELECT
      o.observation_id, o.case_id, o.source_type, o.field,
      o.value, o.confidence, tl.verified_value
    FROM observations o
    INNER JOIN training_labels tl
      ON tl.case_id = o.case_id AND tl.field = o.field
    WHERE o.field NOT IN ('raw_ocr_text')
    ORDER BY o.case_id
  `);
  return rows;
}

function isCorrect(predicted: string, verified: string): boolean {
  return predicted.trim().toLowerCase() === verified.trim().toLowerCase();
}

/**
 * Computes Expected Calibration Error across confidence bins.
 */
function computeCalibrationMetrics(
  data: { confidence: number; correct: boolean }[],
): { ece: number; mce: number; bins: CalibrationBin[] } {
  const bins: CalibrationBin[] = [];
  const binWidth = 1 / NUM_CALIBRATION_BINS;

  for (let i = 0; i < NUM_CALIBRATION_BINS; i++) {
    const binStart = i * binWidth;
    const binEnd = (i + 1) * binWidth;
    const inBin = data.filter(
      (d) => d.confidence >= binStart && d.confidence < (i === NUM_CALIBRATION_BINS - 1 ? 1.01 : binEnd),
    );

    if (inBin.length === 0) {
      bins.push({ bin_start: binStart, bin_end: binEnd, avg_confidence: 0, avg_accuracy: 0, count: 0 });
      continue;
    }

    const avgConf = inBin.reduce((s, d) => s + d.confidence, 0) / inBin.length;
    const avgAcc = inBin.filter((d) => d.correct).length / inBin.length;

    bins.push({
      bin_start: binStart,
      bin_end: binEnd,
      avg_confidence: avgConf,
      avg_accuracy: avgAcc,
      count: inBin.length,
    });
  }

  let ece = 0;
  let mce = 0;
  for (const bin of bins) {
    if (bin.count === 0) continue;
    const gap = Math.abs(bin.avg_confidence - bin.avg_accuracy);
    ece += (bin.count / data.length) * gap;
    mce = Math.max(mce, gap);
  }

  return { ece, mce, bins };
}

function computePrecisionRecallF1(
  data: { correct: boolean }[],
): { precision: number; recall: number; f1: number } {
  const tp = data.filter((d) => d.correct).length;
  const total = data.length;

  if (total === 0) return { precision: 0, recall: 0, f1: 0 };

  const precision = tp / total;
  const recall = tp / total;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  return { precision, recall, f1 };
}

function computeSubgroupMetrics(
  data: LabeledObservation[],
  groupKey: "field" | "source_type",
): Record<string, { accuracy: number; f1: number; ece: number; count: number }> {
  const groups = new Map<string, LabeledObservation[]>();
  for (const d of data) {
    const key = d[groupKey];
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(d);
  }

  const result: Record<string, { accuracy: number; f1: number; ece: number; count: number }> = {};

  for (const [key, items] of groups) {
    const annotated = items.map((d) => ({
      confidence: d.confidence,
      correct: isCorrect(d.value, d.verified_value),
    }));

    const accuracy = annotated.filter((d) => d.correct).length / annotated.length;
    const { f1 } = computePrecisionRecallF1(annotated);
    const { ece } = computeCalibrationMetrics(annotated);

    result[key] = { accuracy, f1, ece, count: items.length };
  }

  return result;
}

/**
 * Runs offline evaluation of the understanding pipeline against labeled data.
 * Returns comprehensive metrics including accuracy, F1, ECE, and per-field/source breakdowns.
 */
export async function evaluatePipeline(modelId?: string): Promise<EvalMetrics> {
  const data = await fetchLabeledData();

  if (data.length === 0) {
    logger.warn("No labeled data available for evaluation");
    return {
      accuracy: 0, precision: 0, recall: 0, f1: 0, ece: 0, mce: 0,
      sample_count: 0, per_field: {}, per_source: {}, calibration_bins: [],
    };
  }

  const annotated = data.map((d) => ({
    confidence: d.confidence,
    correct: isCorrect(d.value, d.verified_value),
  }));

  const accuracy = annotated.filter((d) => d.correct).length / annotated.length;
  const { precision, recall, f1 } = computePrecisionRecallF1(annotated);
  const { ece, mce, bins } = computeCalibrationMetrics(annotated);
  const perField = computeSubgroupMetrics(data, "field");
  const perSource = computeSubgroupMetrics(data, "source_type");

  const metrics: EvalMetrics = {
    accuracy,
    precision,
    recall,
    f1,
    ece,
    mce,
    sample_count: data.length,
    per_field: perField,
    per_source: perSource,
    calibration_bins: bins,
  };

  if (modelId) {
    try {
      const evalId = `eval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      await pool.query(
        `INSERT INTO eval_results (eval_id, model_id, dataset, metrics)
         VALUES ($1, $2, $3, $4)`,
        [evalId, modelId, "production_labels", JSON.stringify(metrics)],
      );
      logger.info("Evaluation results persisted", { eval_id: evalId, model_id: modelId });
    } catch (e) {
      logger.warn("Failed to persist eval results", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  logger.info("Pipeline evaluation completed", {
    accuracy: accuracy.toFixed(3),
    f1: f1.toFixed(3),
    ece: ece.toFixed(3),
    samples: data.length,
  });

  return metrics;
}
