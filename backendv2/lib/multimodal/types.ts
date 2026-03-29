export const CONFIDENCE_HIGH = 0.90;
export const CONFIDENCE_PROBABLE = 0.70;
export const CONFIDENCE_WEAK = 0.40;

export type SourceType =
  | "ocr"
  | "classifier"
  | "gemini"
  | "text_parse"
  | "catalog_lookup"
  | "user_metadata"
  | "logo_detector"
  | "panel_similarity"
  | "audio_detector";

export type ObservationField =
  | "appliance_type"
  | "brand"
  | "model"
  | "serial"
  | "error_code"
  | "symptom"
  | "raw_ocr_text";

export type RegionType =
  | "model_plate"
  | "display"
  | "panel"
  | "label"
  | null;

export interface Observation {
  observation_id: string;
  case_id: string;
  asset_id: string | null;
  source_type: SourceType;
  field: ObservationField;
  value: string;
  confidence: number;
  region_type: RegionType;
  metadata: Record<string, unknown> | null;
}

export interface Candidate {
  candidate_id: string;
  case_id: string;
  candidate_type: string;
  value: string;
  rank: number;
  confidence: number;
  supporting_obs_ids: string[];
}

export interface ApplianceTypePrediction {
  top_prediction: string;
  confidence: number;
  alternatives: { label: string; confidence: number }[];
}

export interface BrandCandidate {
  brand: string;
  confidence: number;
  evidence: string[];
}

export interface ModelCandidate {
  model: string;
  confidence: number;
  rank: number;
  evidence: string[];
  near_variant?: boolean;
}

export interface ErrorCode {
  value: string;
  confidence: number;
  source: string;
}

export interface SymptomTag {
  tag: string;
  confidence: number;
  source: string;
}

export type IdentityLevel = "exact" | "series" | "brand_plus_type" | "type_only";

export interface FallbackStatus {
  resolved_identity_level: IdentityLevel;
  exact_model_resolved: boolean;
  recommended_retrieval_scope: string[];
}

export interface UnderstandingOutput {
  case_id: string;
  understanding_id: string;
  appliance_type: ApplianceTypePrediction;
  brand_candidates: BrandCandidate[];
  model_candidates: ModelCandidate[];
  error_codes: ErrorCode[];
  symptoms: SymptomTag[];
  fallback_status: FallbackStatus;
}

export type UnderstandingStage =
  | "classify"
  | "logo_detect"
  | "ocr"
  | "extract"
  | "panel_similarity"
  | "symptoms"
  | "audio"
  | "fusion"
  | "rank";

let _obsCounter = 0;
export function generateObservationId(): string {
  return `obs_${Date.now()}_${++_obsCounter}`;
}

let _candCounter = 0;
export function generateCandidateId(): string {
  return `cand_${Date.now()}_${++_candCounter}`;
}

export function generateUnderstandingId(): string {
  return `und_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
