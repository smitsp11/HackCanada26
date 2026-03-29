import sharp from "sharp";
import { logger } from "../observability";

export interface ScoredFrame {
  storagePath: string;
  score: number;
  lowQuality: boolean;
}

const DEFAULT_TOP_N = 5;
const BLUR_THRESHOLD = 50;

/**
 * Estimates blur via Laplacian variance: sharpen the image and measure
 * the standard deviation of pixel intensities. Higher = sharper.
 */
async function computeBlurScore(buffer: Buffer): Promise<number> {
  try {
    const { data, info } = await sharp(buffer)
      .grayscale()
      .resize(256, 256, { fit: "fill" })
      .convolve({
        width: 3,
        height: 3,
        kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0],
      })
      .raw()
      .toBuffer({ resolveWithObject: true });

    let sum = 0;
    let sumSq = 0;
    const n = info.width * info.height;
    for (let i = 0; i < n; i++) {
      sum += data[i];
      sumSq += data[i] * data[i];
    }
    const mean = sum / n;
    return sumSq / n - mean * mean;
  } catch {
    return 0;
  }
}

/**
 * Estimates exposure quality: measures how far mean brightness deviates
 * from ideal mid-tone. Returns 0-1 where 1 = ideal exposure.
 */
async function computeExposureScore(buffer: Buffer): Promise<number> {
  try {
    const { data, info } = await sharp(buffer)
      .grayscale()
      .resize(64, 64, { fit: "fill" })
      .raw()
      .toBuffer({ resolveWithObject: true });

    let sum = 0;
    const n = info.width * info.height;
    for (let i = 0; i < n; i++) sum += data[i];
    const mean = sum / n;
    return 1 - Math.abs(mean - 128) / 128;
  } catch {
    return 0.5;
  }
}

/**
 * Scores and selects the best N frames from a list of frame buffers.
 * Always returns at least min(topN, frames.length) frames -- never zero.
 * Low-quality frames are tagged but still returned.
 */
export async function selectBestFrames(
  frames: { storagePath: string; buffer: Buffer }[],
  topN: number = DEFAULT_TOP_N,
  ctx?: Record<string, unknown>,
): Promise<ScoredFrame[]> {
  if (frames.length === 0) return [];

  const scored: { storagePath: string; blur: number; exposure: number; combined: number }[] = [];

  for (const frame of frames) {
    const [blur, exposure] = await Promise.all([
      computeBlurScore(frame.buffer),
      computeExposureScore(frame.buffer),
    ]);

    const combined = blur * 0.7 + exposure * 100 * 0.3;
    scored.push({ storagePath: frame.storagePath, blur, exposure, combined });
  }

  scored.sort((a, b) => b.combined - a.combined);

  const selected = scored.slice(0, topN);
  const result: ScoredFrame[] = selected.map((s) => ({
    storagePath: s.storagePath,
    score: s.combined,
    lowQuality: s.blur < BLUR_THRESHOLD,
  }));

  const lowCount = result.filter((r) => r.lowQuality).length;
  if (lowCount === result.length && ctx) {
    logger.warn(`All ${result.length} selected frames below blur threshold`, ctx);
  }

  return result;
}
