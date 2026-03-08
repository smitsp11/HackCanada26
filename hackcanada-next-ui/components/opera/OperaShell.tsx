"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { useOperaReducer } from "@/hooks/useOperaReducer";
import { useSSE } from "@/hooks/useSSE";
import Phase1Ingestion from "./Phase1Ingestion";
import Phase2Cognitive from "./Phase2Cognitive";
import Phase3Synthesis from "./Phase3Synthesis";
import ResultPane from "./ResultPane";

interface OperaShellProps {
  assetUrls: [string, string, string];
  symptom: string;
}

export default function OperaShell({ assetUrls, symptom }: OperaShellProps) {
  const [state, dispatch] = useOperaReducer();
  const [sseEnabled, setSSEEnabled] = useState(false);
  const started = useRef(false);
  const advanceScheduled = useRef(false);

  useSSE({
    url: "/api/diagnose?urls=" + encodeURIComponent(JSON.stringify(assetUrls)),
    enabled: sseEnabled,
    dispatch,
  });

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    dispatch({ type: "UPLOAD_COMPLETE" });
    setSSEEnabled(true);
  }, [dispatch]);

  useEffect(() => {
    const allComplete =
      state.phase === "PHASE_1_INGESTION" &&
      state.slots.every((s) => s === "complete");
    if (!allComplete || advanceScheduled.current) return;
    advanceScheduled.current = true;
    const t = setTimeout(() => {
      dispatch({ type: "ADVANCE_TO_PHASE_2" });
    }, 800);
    return () => clearTimeout(t);
  }, [state.phase, state.slots, dispatch]);

  return (
    <div className="relative min-h-screen w-full">
      <AnimatePresence mode="wait">
        {state.phase === "PHASE_1_INGESTION" && (
          <Phase1Ingestion
            key="phase1"
            slots={state.slots}
            slotUrls={state.slotUrls}
            logs={state.diagnosticLogs}
          />
        )}

        {state.phase === "PHASE_2_COGNITIVE" && (
          <Phase2Cognitive
            key="phase2"
            slotUrls={state.slotUrls}
            deviceId={state.deviceId}
            manualMatch={state.manualMatch}
            logs={state.diagnosticLogs}
            onManualReady={() => {
              dispatch({ type: "MANUAL_RETRIEVED" });
            }}
          />
        )}

        {state.phase === "PHASE_3_SYNTHESIS" && (
          <Phase3Synthesis
            key="phase3"
            progress={state.synthesisProgress}
            logs={state.diagnosticLogs}
          />
        )}

        {state.phase === "COMPLETE" && state.repairSteps && (
          <ResultPane
            key="complete"
            steps={state.repairSteps}
            logs={state.diagnosticLogs}
            deviceId={state.deviceId}
            symptom={symptom}
          />
        )}

        {state.phase === "ERROR" && (
          <div
            key="error"
            className="flex min-h-screen flex-col items-center justify-center px-8"
          >
            <div className="opera-border opera-shadow bg-white p-12">
              <p className="opera-label mb-4 text-red-600">
                S Y S T E M &nbsp; E R R O R
              </p>
              <p className="font-mono text-sm text-black">
                {state.error || "An unknown error occurred."}
              </p>
              <button
                className="opera-border mt-8 bg-black px-6 py-2 font-mono text-xs text-white"
                onClick={() => {
                  dispatch({ type: "RESET" });
                  setSSEEnabled(false);
                }}
              >
                R E S E T
              </button>
            </div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
