"use client";

import { useCallback, useEffect, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { useOperaReducer } from "@/hooks/useOperaReducer";
import { useSSE } from "@/hooks/useSSE";
import { getOperaTestState } from "@/lib/test-fixtures";
import Phase1Ingestion from "./Phase1Ingestion";
import TransitionCut from "./TransitionCut";
import Phase2Cognitive from "./Phase2Cognitive";
import Phase3Synthesis from "./Phase3Synthesis";
import ResultPane from "./ResultPane";

interface OperaShellProps {
  testStateKey?: string | null;
}

export default function OperaShell({ testStateKey }: OperaShellProps) {
  const [state, dispatch] = useOperaReducer();
  const [sseEnabled, setSSEEnabled] = useState(false);
  const testState = getOperaTestState(testStateKey);
  const viewState = testState ?? state;

  useSSE({
    url: "/api/diagnose",
    enabled: sseEnabled && !testState,
    dispatch,
  });

  const handleStart = useCallback(() => {
    if (testState) return;
    dispatch({ type: "UPLOAD_COMPLETE" });
    setSSEEnabled(true);
  }, [dispatch, testState]);

  // Listen for postMessage from another page to trigger the animation
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.data?.type === "OPERA_START") {
        handleStart();
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [handleStart]);

  const handleCutComplete = useCallback(() => {
    if (testState) return;
    dispatch({ type: "CUT_COMPLETE" });
  }, [dispatch, testState]);

  return (
    <div className="relative min-h-screen w-full">
      <AnimatePresence mode="wait">
        {viewState.phase === "PHASE_1_INGESTION" && (
          <Phase1Ingestion
            key="phase1"
            slots={viewState.slots}
            slotUrls={viewState.slotUrls}
            logs={viewState.diagnosticLogs}
          />
        )}

        {viewState.phase === "PHASE_2_COGNITIVE" && (
          <Phase2Cognitive
            key="phase2"
            slotUrls={viewState.slotUrls}
            deviceId={viewState.deviceId}
            manualMatch={viewState.manualMatch}
            logs={viewState.diagnosticLogs}
            onManualReady={() => {
              if (!testState) {
                dispatch({ type: "MANUAL_RETRIEVED" });
              }
            }}
          />
        )}

        {viewState.phase === "PHASE_3_SYNTHESIS" && (
          <Phase3Synthesis
            key="phase3"
            progress={viewState.synthesisProgress}
            logs={viewState.diagnosticLogs}
          />
        )}

        {viewState.phase === "COMPLETE" && viewState.repairSteps && (
          <ResultPane
            key="complete"
            steps={viewState.repairSteps}
            logs={viewState.diagnosticLogs}
          />
        )}

        {viewState.phase === "ERROR" && (
          <div
            key="error"
            className="flex min-h-screen flex-col items-center justify-center px-8"
          >
            <div className="opera-border opera-shadow bg-white p-12">
              <p className="opera-label mb-4 text-red-600">
                S Y S T E M &nbsp; E R R O R
              </p>
              <p className="font-mono text-sm text-black">
                {viewState.error || "An unknown error occurred."}
              </p>
              <button
                className="opera-border mt-8 bg-black px-6 py-2 font-mono text-xs text-white"
                onClick={() => {
                  if (testState) return;
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

      <AnimatePresence>
        {viewState.phase === "TRANSITION_CUT" && (
          <TransitionCut key="cut" onComplete={handleCutComplete} />
        )}
      </AnimatePresence>
    </div>
  );
}
