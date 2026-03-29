export interface RepairStep {
  id: number;
  instruction: string;
  schematicUrl: string | null;
}

export type CaseStatus =
  | "created"
  | "awaiting_upload"
  | "uploading"
  | "validating"
  | "preprocessing"
  | "analyzing"
  | "ready_for_analysis"
  | "preprocessing_failed"
  | "failed_validation";

export type SSEEvent =
  | { type: "case_status"; status: CaseStatus }
  | { type: "preprocessing_progress"; total: number; done: number; ready: number; uploaded: number }
  | { type: "asset_preprocessed"; asset_id: string; slot_key: string; validation_status: string; processing_status: string }
  | { type: "slot_processing"; slotIndex: number }
  | { type: "slot_complete"; slotIndex: number; url: string }
  | { type: "device_identified"; makeModel: string }
  | { type: "manual_found"; manualId: string; title: string }
  | { type: "symptom_sections_found"; symptom: string; sections: string }
  | { type: "parts_check_complete"; parts: string }
  | { type: "synthesis_progress"; percent: number; log: string }
  | { type: "synthesis_complete"; steps: RepairStep[] }
  | { type: "error"; message: string };

export function parseSSEEvent(data: string): SSEEvent | null {
  try {
    const parsed = JSON.parse(data);
    if (parsed && typeof parsed.type === "string") {
      return parsed as SSEEvent;
    }
    return null;
  } catch {
    return null;
  }
}
