import type { OperaState } from "@/hooks/useOperaReducer";

export const OPERA_TEST_STATE_KEYS = [
  "idle",
  "phase1-initial",
  "phase1-mixed",
  "phase1-complete",
  "transition-cut",
  "phase2-pre-id",
  "phase2-matched",
  "phase3-0",
  "phase3-30",
  "phase3-70",
  "phase3-100",
  "phase3-clamp-low",
  "phase3-clamp-high",
  "complete-no-schematic",
  "complete-with-schematic",
  "error",
] as const;

export type OperaTestStateKey = (typeof OPERA_TEST_STATE_KEYS)[number];

const baseLogs = [
  "INITIALIZING_PIPELINE...",
  "EXTRACTING_FRAMES...",
  "APPLYING_ENHANCEMENT...",
  "COGNITIVE_ENGINE_ONLINE",
  "SCANNING_DEVICE_SIGNATURE...",
];

const baseState: OperaState = {
  phase: "IDLE",
  slots: ["idle", "idle", "idle", "idle"],
  slotUrls: [null, null, null, null],
  deviceId: null,
  manualMatch: null,
  synthesisProgress: 0,
  diagnosticLogs: [],
  repairSteps: null,
  error: null,
};

const slotUrls: [string | null, string | null, string | null, string | null] = [
  "/api/diagnose/placeholder?slot=0",
  "/api/diagnose/placeholder?slot=1",
  "/api/diagnose/placeholder?slot=2",
  "/api/diagnose/placeholder?slot=3",
];

const withLongLogs = Array.from({ length: 24 }, (_, index) => {
  const n = String(index + 1).padStart(2, "0");
  return `LOG_ENTRY_${n}_CROSS_REFERENCING_SYMPTOM_LOG`;
});

const stepsNoSchematic = [
  {
    id: 1,
    instruction:
      "Disconnect power from the appliance and wait 30 seconds before opening the front service panel.",
    schematicUrl: null,
  },
  {
    id: 2,
    instruction:
      "Inspect the drain pump housing for obstructions and remove debris from the impeller path.",
    schematicUrl: null,
  },
  {
    id: 3,
    instruction:
      "Reseat the valve harness connectors and run a rinse-only cycle to confirm stable operation.",
    schematicUrl: null,
  },
];

const stepsWithSchematic = [
  ...stepsNoSchematic,
  {
    id: 4,
    instruction:
      "Use the marked torque points shown in the schematic to tighten the lower access frame bolts.",
    schematicUrl: "https://placehold.co/600x400/png?text=SCHEMATIC+04",
  },
];

const stateMap: Record<OperaTestStateKey, OperaState> = {
  idle: {
    ...baseState,
    phase: "IDLE",
  },
  "phase1-initial": {
    ...baseState,
    phase: "PHASE_1_INGESTION",
    slots: ["processing", "idle", "idle", "idle"],
    diagnosticLogs: baseLogs.slice(0, 3),
  },
  "phase1-mixed": {
    ...baseState,
    phase: "PHASE_1_INGESTION",
    slots: ["complete", "processing", "idle", "complete"],
    slotUrls,
    diagnosticLogs: withLongLogs,
  },
  "phase1-complete": {
    ...baseState,
    phase: "PHASE_1_INGESTION",
    slots: ["complete", "complete", "complete", "complete"],
    slotUrls,
    diagnosticLogs: [
      ...baseLogs,
      "SLOT_0_LOCKED [OK]",
      "SLOT_1_LOCKED [OK]",
      "SLOT_2_LOCKED [OK]",
      "SLOT_3_LOCKED [OK]",
    ],
  },
  "transition-cut": {
    ...baseState,
    phase: "TRANSITION_CUT",
    slots: ["complete", "complete", "complete", "complete"],
    slotUrls,
    diagnosticLogs: [...baseLogs, "ALL_SLOTS_COMPLETE"],
  },
  "phase2-pre-id": {
    ...baseState,
    phase: "PHASE_2_COGNITIVE",
    slots: ["complete", "complete", "complete", "complete"],
    slotUrls,
    diagnosticLogs: [...baseLogs, "SCANNING_DEVICE_SIGNATURE..."],
  },
  "phase2-matched": {
    ...baseState,
    phase: "PHASE_2_COGNITIVE",
    slots: ["complete", "complete", "complete", "complete"],
    slotUrls,
    deviceId: "Comfort™ 96 Condensing Gas Furnace",
    manualMatch: {
      id: "59SC6A060M17--16",
      title: "Carrier Comfort™ 96 Condensing Gas Furnace Service Manual",
    },
    diagnosticLogs: [...baseLogs, "MATCH_FOUND: Comfort™ 96 Condensing Gas Furnace"],
  },
  "phase3-0": {
    ...baseState,
    phase: "PHASE_3_SYNTHESIS",
    synthesisProgress: 0,
    diagnosticLogs: baseLogs,
  },
  "phase3-30": {
    ...baseState,
    phase: "PHASE_3_SYNTHESIS",
    synthesisProgress: 30,
    diagnosticLogs: [...baseLogs, "ANALYZING_AUDIO_ANOMALIES..."],
  },
  "phase3-70": {
    ...baseState,
    phase: "PHASE_3_SYNTHESIS",
    synthesisProgress: 70,
    diagnosticLogs: [...baseLogs, "GENERATING_REPAIR_INSTRUCTIONS..."],
  },
  "phase3-100": {
    ...baseState,
    phase: "PHASE_3_SYNTHESIS",
    synthesisProgress: 100,
    diagnosticLogs: [...baseLogs, "GENERATING_VISUAL_SCHEMATICS..."],
  },
  "phase3-clamp-low": {
    ...baseState,
    phase: "PHASE_3_SYNTHESIS",
    synthesisProgress: -10,
    diagnosticLogs: baseLogs,
  },
  "phase3-clamp-high": {
    ...baseState,
    phase: "PHASE_3_SYNTHESIS",
    synthesisProgress: 150,
    diagnosticLogs: [...baseLogs, "POST_PROCESS_COMPLETE"],
  },
  "complete-no-schematic": {
    ...baseState,
    phase: "COMPLETE",
    repairSteps: stepsNoSchematic,
    diagnosticLogs: withLongLogs,
  },
  "complete-with-schematic": {
    ...baseState,
    phase: "COMPLETE",
    repairSteps: stepsWithSchematic,
    diagnosticLogs: withLongLogs,
  },
  error: {
    ...baseState,
    phase: "ERROR",
    error: "Connection lost after maximum retries",
    diagnosticLogs: [...baseLogs, "ERROR: Connection lost after maximum retries"],
  },
};

export function getOperaTestState(
  key: string | null | undefined
): OperaState | null {
  if (!key) return null;
  if (key in stateMap) {
    return stateMap[key as OperaTestStateKey];
  }
  return null;
}
