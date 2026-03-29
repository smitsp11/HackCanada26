import sharp from "sharp";
import type { Observation } from "./types";
import { generateObservationId } from "./types";
import { getSession, runInference, float32Tensor, getFloat32Output } from "./onnx-inference";
import { logger } from "../observability";
import pool from "../db";

const ONNX_MODEL_NAME = "panel_embedder";
const EMBEDDING_INPUT_SIZE = 224;
const SIMILARITY_THRESHOLD = 0.70;
const MAX_NEIGHBORS = 3;

interface ProductEmbedding {
  product_id: number;
  company: string;
  model_number: string;
  embedding: number[];
}

let embeddingCache: ProductEmbedding[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Loads reference panel embeddings from the products table.
 * Caches results for CACHE_TTL_MS.
 */
async function loadReferenceEmbeddings(): Promise<ProductEmbedding[]> {
  if (embeddingCache && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return embeddingCache;
  }

  try {
    const { rows } = await pool.query<{
      id: number;
      company: string;
      model_number: string;
      panel_embedding: number[] | null;
    }>(
      `SELECT id, company, model_number, panel_embedding
       FROM products
       WHERE panel_embedding IS NOT NULL`,
    );

    embeddingCache = rows.map((r) => ({
      product_id: r.id,
      company: r.company,
      model_number: r.model_number,
      embedding: r.panel_embedding!,
    }));
    cacheTimestamp = Date.now();
    return embeddingCache;
  } catch {
    return [];
  }
}

/**
 * Preprocesses an image for the embedding model: resize to 224x224, normalize to ImageNet stats.
 */
async function preprocessForEmbedding(imageUrl: string): Promise<Float32Array | null> {
  try {
    const res = await fetch(imageUrl);
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());

    const { data } = await sharp(buffer)
      .resize(EMBEDDING_INPUT_SIZE, EMBEDDING_INPUT_SIZE, { fit: "cover" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const mean = [0.485, 0.456, 0.406];
    const std = [0.229, 0.224, 0.225];
    const pixels = EMBEDDING_INPUT_SIZE * EMBEDDING_INPUT_SIZE;
    const chw = new Float32Array(3 * pixels);

    for (let i = 0; i < pixels; i++) {
      chw[i] = (data[i * 3] / 255 - mean[0]) / std[0];
      chw[pixels + i] = (data[i * 3 + 1] / 255 - mean[1]) / std[1];
      chw[2 * pixels + i] = (data[i * 3 + 2] / 255 - mean[2]) / std[2];
    }
    return chw;
  } catch {
    return null;
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

interface SimilarityMatch {
  company: string;
  model_number: string;
  similarity: number;
}

/**
 * Finds nearest product matches by panel embedding similarity.
 */
function findNearestNeighbors(
  queryEmbedding: number[],
  references: ProductEmbedding[],
): SimilarityMatch[] {
  const scored = references.map((ref) => ({
    company: ref.company,
    model_number: ref.model_number,
    similarity: cosineSimilarity(queryEmbedding, ref.embedding),
  }));

  return scored
    .filter((s) => s.similarity >= SIMILARITY_THRESHOLD)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, MAX_NEIGHBORS);
}

/**
 * Computes panel-layout similarity between uploaded images and the product reference index.
 * Returns observations for matching models. Returns empty array if model/index unavailable.
 */
export async function matchPanelSimilarity(
  caseId: string,
  imageAssets: { asset_id: string; url: string }[],
): Promise<Observation[]> {
  const handle = await getSession(ONNX_MODEL_NAME);
  if (!handle) {
    logger.info("Panel embedder model not available, skipping", { case_id: caseId });
    return [];
  }

  const references = await loadReferenceEmbeddings();
  if (references.length === 0) {
    logger.info("No reference panel embeddings in products table, skipping", { case_id: caseId });
    return [];
  }

  const observations: Observation[] = [];

  for (const asset of imageAssets) {
    try {
      const tensor = await preprocessForEmbedding(asset.url);
      if (!tensor) continue;

      const input = float32Tensor(tensor, [1, 3, EMBEDDING_INPUT_SIZE, EMBEDDING_INPUT_SIZE]);
      const result = await runInference(handle, { input });
      if (!result) continue;

      const outputKey = Object.keys(result)[0];
      const embeddingRaw = getFloat32Output(result[outputKey]);
      const queryEmbedding = Array.from(embeddingRaw);

      const matches = findNearestNeighbors(queryEmbedding, references);

      for (const match of matches) {
        observations.push({
          observation_id: generateObservationId(),
          case_id: caseId,
          asset_id: asset.asset_id,
          source_type: "panel_similarity",
          field: "model",
          value: match.model_number,
          confidence: match.similarity,
          region_type: "panel",
          metadata: {
            matched_brand: match.company,
            cosine_similarity: match.similarity,
            inference_method: "onnx_embedding",
          },
        });

        observations.push({
          observation_id: generateObservationId(),
          case_id: caseId,
          asset_id: asset.asset_id,
          source_type: "panel_similarity",
          field: "brand",
          value: match.company,
          confidence: match.similarity * 0.95,
          region_type: "panel",
          metadata: {
            derived_from_model_match: match.model_number,
            inference_method: "onnx_embedding",
          },
        });
      }
    } catch (e) {
      logger.warn("Panel similarity failed for asset", {
        case_id: caseId,
        asset_id: asset.asset_id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  if (observations.length > 0) {
    logger.info("Panel similarity completed", {
      case_id: caseId,
      matches: observations.length / 2,
    });
  }

  return observations;
}
