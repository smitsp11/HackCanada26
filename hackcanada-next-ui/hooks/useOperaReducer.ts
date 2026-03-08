"use client";

import { useReducer } from "react";
import type { RepairStep } from "@/lib/events";

export type Phase =
  | "IDLE"
  | "PHASE_1_INGESTION"
  | "TRANSITION_CUT"
  | "PHASE_2_COGNITIVE"
  | "PHASE_3_SYNTHESIS"
  | "COMPLETE"
  | "ERROR";

export type SlotStatus = "idle" | "processing" | "complete";

export interface OperaState {
  phase: Phase;
  slots: [SlotStatus, SlotStatus, SlotStatus];
  slotUrls: [string | null, string | null, string | null];
  deviceId: string | null;
  manualMatch: { id: string; title: string } | null;
  synthesisProgress: number;
  diagnosticLogs: string[];
  repairSteps: RepairStep[] | null;
  error: string | null;
}

export type OperaAction =
  | { type: "UPLOAD_COMPLETE" }
  | { type: "SLOT_PROCESSING"; slotIndex: number }
  | { type: "SLOT_COMPLETE"; slotIndex: number; url: string }
  | { type: "ALL_SLOTS_DONE" }
  | { type: "CUT_COMPLETE" }
  | { type: "ADVANCE_TO_PHASE_2" }
  | { type: "DEVICE_IDENTIFIED"; makeModel: string }
  | { type: "MANUAL_FOUND"; manualId: string; title: string }
  | { type: "MANUAL_RETRIEVED" }
  | { type: "SYNTHESIS_PROGRESS"; percent: number; log: string }
  | { type: "SYNTHESIS_COMPLETE"; steps: RepairStep[] }
  | { type: "ADD_LOG"; message: string }
  | { type: "ERROR"; message: string }
  | { type: "RESET" };

const initialState: OperaState = {
  phase: "IDLE",
  slots: ["idle", "idle", "idle"],
  slotUrls: [null, null, null],
  deviceId: null,
  manualMatch: null,
  synthesisProgress: 0,
  diagnosticLogs: [],
  repairSteps: null,
  error: null,
};

function updateSlot<T>(
  arr: [T, T, T],
  index: number,
  value: T
): [T, T, T] {
  const next = [...arr] as [T, T, T];
  next[index] = value;
  return next;
}

function operaReducer(state: OperaState, action: OperaAction): OperaState {
  switch (action.type) {
    case "UPLOAD_COMPLETE":
      return {
        ...state,
        phase: "PHASE_1_INGESTION",
        diagnosticLogs: ["INITIALIZING_PIPELINE..."],
      };

    case "SLOT_PROCESSING":
      return {
        ...state,
        slots: updateSlot(state.slots, action.slotIndex, "processing"),
        diagnosticLogs: [
          ...state.diagnosticLogs,
          `PROCESSING_SLOT_${action.slotIndex}...`,
        ],
      };

    case "SLOT_COMPLETE": {
      const newSlots = updateSlot(state.slots, action.slotIndex, "complete");
      const newUrls = updateSlot(state.slotUrls, action.slotIndex, action.url);
      const allDone = newSlots.every((s) => s === "complete");
      return {
        ...state,
        slots: newSlots,
        slotUrls: newUrls,
        diagnosticLogs: [
          ...state.diagnosticLogs,
          `SLOT_${action.slotIndex}_LOCKED [OK]`,
        ],
        phase: state.phase,
      };
    }

    case "ALL_SLOTS_DONE":
      return { ...state, phase: "PHASE_2_COGNITIVE" };

    case "CUT_COMPLETE":
      return {
        ...state,
        phase: "PHASE_2_COGNITIVE",
        diagnosticLogs: [
          ...state.diagnosticLogs,
          "COGNITIVE_ENGINE_ONLINE",
          "SCANNING_DEVICE_SIGNATURE...",
        ],
      };

    case "ADVANCE_TO_PHASE_2":
      return {
        ...state,
        phase: "PHASE_2_COGNITIVE",
        diagnosticLogs: [
          ...state.diagnosticLogs,
          "COGNITIVE_ENGINE_ONLINE",
          "SCANNING_DEVICE_SIGNATURE...",
        ],
      };

    case "DEVICE_IDENTIFIED":
      return {
        ...state,
        deviceId: action.makeModel,
        diagnosticLogs: [
          ...state.diagnosticLogs,
          `MATCH_FOUND: ${action.makeModel}`,
        ],
      };

    case "MANUAL_FOUND":
      return {
        ...state,
        manualMatch: { id: action.manualId, title: action.title },
        diagnosticLogs: [
          ...state.diagnosticLogs,
          `MANUAL_RETRIEVED: ${action.title}`,
        ],
      };

    case "MANUAL_RETRIEVED":
      return {
        ...state,
        phase: "PHASE_3_SYNTHESIS",
        diagnosticLogs: [
          ...state.diagnosticLogs,
          "INITIATING_SYNTHESIS...",
        ],
      };

    case "SYNTHESIS_PROGRESS":
      return {
        ...state,
        synthesisProgress: action.percent,
        diagnosticLogs: [...state.diagnosticLogs, action.log],
      };

    case "SYNTHESIS_COMPLETE":
      return {
        ...state,
        phase: "COMPLETE",
        synthesisProgress: 100,
        repairSteps: action.steps,
        diagnosticLogs: [
          ...state.diagnosticLogs,
          "SYNTHESIS_COMPLETE",
          "DIAGNOSTIC_READY",
        ],
      };

    case "ADD_LOG":
      return {
        ...state,
        diagnosticLogs: [...state.diagnosticLogs, action.message],
      };

    case "ERROR":
      return {
        ...state,
        phase: "ERROR",
        error: action.message,
        diagnosticLogs: [
          ...state.diagnosticLogs,
          `ERROR: ${action.message}`,
        ],
      };

    case "RESET":
      return initialState;

    default:
      return state;
  }
}

export function useOperaReducer() {
  return useReducer(operaReducer, initialState);
}
