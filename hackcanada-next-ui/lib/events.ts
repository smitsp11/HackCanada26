export interface RepairStep {
  id: number;
  instruction: string;
  schematicUrl: string | null;
}

export type SSEEvent =
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
