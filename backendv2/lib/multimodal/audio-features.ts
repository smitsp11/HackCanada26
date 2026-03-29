/**
 * Audio feature extraction for anomaly detection.
 * Computes mel-spectrogram features from 16kHz mono PCM WAV buffers.
 */

const SAMPLE_RATE = 16000;
const FFT_SIZE = 512;
const HOP_LENGTH = 256;
const N_MELS = 64;
const MEL_FMIN = 0;
const MEL_FMAX = 8000;

/**
 * Parses a 16-bit PCM WAV buffer into a float32 samples array.
 * Assumes 16kHz, mono, 16-bit signed LE (as produced by our ffmpeg extraction).
 */
export function parseWav(buffer: Buffer): Float32Array {
  const dataOffset = 44;
  const numSamples = (buffer.length - dataOffset) / 2;
  const samples = new Float32Array(numSamples);

  for (let i = 0; i < numSamples; i++) {
    const raw = buffer.readInt16LE(dataOffset + i * 2);
    samples[i] = raw / 32768;
  }

  return samples;
}

function hzToMel(hz: number): number {
  return 2595 * Math.log10(1 + hz / 700);
}

function melToHz(mel: number): number {
  return 700 * (Math.pow(10, mel / 2595) - 1);
}

/**
 * Creates a mel filterbank matrix of shape [N_MELS, fftBins].
 */
function createMelFilterbank(fftBins: number): Float32Array[] {
  const melMin = hzToMel(MEL_FMIN);
  const melMax = hzToMel(MEL_FMAX);
  const melPoints = new Float32Array(N_MELS + 2);

  for (let i = 0; i < N_MELS + 2; i++) {
    melPoints[i] = melToHz(melMin + (i / (N_MELS + 1)) * (melMax - melMin));
  }

  const binFreqs = melPoints.map((hz) => Math.round((hz / SAMPLE_RATE) * (FFT_SIZE)));

  const filters: Float32Array[] = [];
  for (let m = 0; m < N_MELS; m++) {
    const filter = new Float32Array(fftBins);
    const fStart = binFreqs[m];
    const fCenter = binFreqs[m + 1];
    const fEnd = binFreqs[m + 2];

    for (let k = fStart; k < fCenter && k < fftBins; k++) {
      filter[k] = (k - fStart) / Math.max(1, fCenter - fStart);
    }
    for (let k = fCenter; k < fEnd && k < fftBins; k++) {
      filter[k] = (fEnd - k) / Math.max(1, fEnd - fCenter);
    }
    filters.push(filter);
  }

  return filters;
}

/**
 * Applies a Hann window to a frame.
 */
function hannWindow(size: number): Float32Array {
  const window = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
  }
  return window;
}

/**
 * Computes the magnitude of a real DFT using a naive O(N^2) approach.
 * For FFT_SIZE=512 this is acceptable for offline inference.
 */
function realDftMagnitude(frame: Float32Array): Float32Array {
  const N = frame.length;
  const bins = Math.floor(N / 2) + 1;
  const mag = new Float32Array(bins);

  for (let k = 0; k < bins; k++) {
    let re = 0;
    let im = 0;
    for (let n = 0; n < N; n++) {
      const angle = (2 * Math.PI * k * n) / N;
      re += frame[n] * Math.cos(angle);
      im -= frame[n] * Math.sin(angle);
    }
    mag[k] = Math.sqrt(re * re + im * im);
  }

  return mag;
}

export interface MelSpectrogramResult {
  /** Mel spectrogram: shape [numFrames, N_MELS] flattened to 1D */
  data: Float32Array;
  numFrames: number;
  numMels: number;
}

/**
 * Computes a log-mel spectrogram from raw PCM samples.
 * Returns a flattened feature matrix suitable for ONNX model input.
 */
export function computeMelSpectrogram(samples: Float32Array): MelSpectrogramResult {
  const window = hannWindow(FFT_SIZE);
  const fftBins = Math.floor(FFT_SIZE / 2) + 1;
  const melBank = createMelFilterbank(fftBins);

  const numFrames = Math.max(1, Math.floor((samples.length - FFT_SIZE) / HOP_LENGTH) + 1);
  const specData = new Float32Array(numFrames * N_MELS);

  for (let t = 0; t < numFrames; t++) {
    const start = t * HOP_LENGTH;
    const frame = new Float32Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE && start + i < samples.length; i++) {
      frame[i] = samples[start + i] * window[i];
    }

    const magnitude = realDftMagnitude(frame);
    const powerSpec = magnitude.map((m) => m * m);

    for (let m = 0; m < N_MELS; m++) {
      let energy = 0;
      for (let k = 0; k < fftBins; k++) {
        energy += melBank[m][k] * powerSpec[k];
      }
      specData[t * N_MELS + m] = Math.log(Math.max(1e-10, energy));
    }
  }

  return { data: specData, numFrames, numMels: N_MELS };
}

/**
 * Computes summary statistics over the mel spectrogram for a compact feature vector.
 * Returns [N_MELS * 4] features: mean, std, max, delta-mean per mel band.
 */
export function computeAudioFeatureVector(spectrogram: MelSpectrogramResult): Float32Array {
  const { data, numFrames, numMels } = spectrogram;
  const features = new Float32Array(numMels * 4);

  for (let m = 0; m < numMels; m++) {
    let sum = 0;
    let max = -Infinity;
    for (let t = 0; t < numFrames; t++) {
      const val = data[t * numMels + m];
      sum += val;
      if (val > max) max = val;
    }
    const mean = sum / numFrames;

    let varSum = 0;
    let deltaSum = 0;
    for (let t = 0; t < numFrames; t++) {
      const val = data[t * numMels + m];
      varSum += (val - mean) * (val - mean);
      if (t > 0) {
        deltaSum += Math.abs(val - data[(t - 1) * numMels + m]);
      }
    }

    features[m] = mean;
    features[numMels + m] = Math.sqrt(varSum / numFrames);
    features[numMels * 2 + m] = max;
    features[numMels * 3 + m] = numFrames > 1 ? deltaSum / (numFrames - 1) : 0;
  }

  return features;
}
