import * as ort from "onnxruntime-node";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../observability";
import pool from "../db";

const SESSION_CACHE = new Map<string, ort.InferenceSession>();

const DEFAULT_MODEL_DIR = join(process.cwd(), "ml", "models");

interface ModelRegistryEntry {
  model_id: string;
  model_name: string;
  version: string;
  onnx_path: string;
  is_active: boolean;
}

/**
 * Looks up the active ONNX model path for a given model name from the registry.
 * Returns null if no active model found or the registry table doesn't exist.
 */
async function resolveModelPath(modelName: string): Promise<string | null> {
  try {
    const { rows } = await pool.query<ModelRegistryEntry>(
      `SELECT onnx_path FROM model_registry WHERE model_name = $1 AND is_active = true ORDER BY created_at DESC LIMIT 1`,
      [modelName],
    );
    if (rows.length > 0 && rows[0].onnx_path) {
      return rows[0].onnx_path;
    }
  } catch {
    // Registry table may not exist yet; fall through to filesystem default
  }
  return null;
}

/**
 * Resolves a model by name: checks the DB registry first, then falls back
 * to the local filesystem at ml/models/{modelName}.onnx.
 */
async function findModelFile(modelName: string): Promise<string | null> {
  const registryPath = await resolveModelPath(modelName);
  if (registryPath && existsSync(registryPath)) {
    return registryPath;
  }

  const localPath = join(DEFAULT_MODEL_DIR, `${modelName}.onnx`);
  if (existsSync(localPath)) {
    return localPath;
  }

  return null;
}

export interface OnnxSessionHandle {
  session: ort.InferenceSession;
  modelName: string;
}

/**
 * Loads (or returns cached) ONNX inference session for the given model name.
 * Returns null if the model file doesn't exist — callers should fall back gracefully.
 */
export async function getSession(modelName: string): Promise<OnnxSessionHandle | null> {
  const cached = SESSION_CACHE.get(modelName);
  if (cached) {
    return { session: cached, modelName };
  }

  const modelPath = await findModelFile(modelName);
  if (!modelPath) {
    logger.info("ONNX model not found, falling back", { model: modelName });
    return null;
  }

  try {
    const modelBuffer = await readFile(modelPath);
    const session = await ort.InferenceSession.create(modelBuffer.buffer as ArrayBuffer, {
      executionProviders: ["cpu"],
    });
    SESSION_CACHE.set(modelName, session);
    logger.info("ONNX model loaded", { model: modelName, path: modelPath });
    return { session, modelName };
  } catch (e) {
    logger.warn("Failed to load ONNX model", {
      model: modelName,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/**
 * Runs inference on a loaded session with the given input tensors.
 * Returns the output map or null on failure.
 */
export async function runInference(
  handle: OnnxSessionHandle,
  feeds: Record<string, ort.Tensor>,
): Promise<Record<string, ort.Tensor> | null> {
  try {
    const results = await handle.session.run(feeds);
    return results as Record<string, ort.Tensor>;
  } catch (e) {
    logger.warn("ONNX inference failed", {
      model: handle.modelName,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/**
 * Creates a float32 tensor from a flat array and shape.
 */
export function float32Tensor(data: number[] | Float32Array, dims: number[]): ort.Tensor {
  const f32 = data instanceof Float32Array ? data : new Float32Array(data);
  return new ort.Tensor("float32", f32, dims);
}

/**
 * Creates an int64 tensor from a flat array and shape.
 */
export function int64Tensor(data: bigint[] | BigInt64Array, dims: number[]): ort.Tensor {
  const i64 = data instanceof BigInt64Array ? data : new BigInt64Array(data);
  return new ort.Tensor("int64", i64, dims);
}

/**
 * Extracts float32 output data from an inference result tensor.
 */
export function getFloat32Output(tensor: ort.Tensor): Float32Array {
  return tensor.data as Float32Array;
}

/**
 * Applies softmax to a raw logits array. Returns probabilities summing to 1.
 */
export function softmax(logits: Float32Array | number[]): number[] {
  const arr = Array.from(logits);
  const max = Math.max(...arr);
  const exps = arr.map((x) => Math.exp(x - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

/**
 * Returns the index of the maximum value in an array.
 */
export function argmax(arr: number[] | Float32Array): number {
  const a = Array.from(arr);
  return a.indexOf(Math.max(...a));
}

/**
 * Evicts a cached session (useful after model updates).
 */
export function evictSession(modelName: string): void {
  SESSION_CACHE.delete(modelName);
}

/**
 * Clears all cached sessions.
 */
export function clearSessionCache(): void {
  SESSION_CACHE.clear();
}
