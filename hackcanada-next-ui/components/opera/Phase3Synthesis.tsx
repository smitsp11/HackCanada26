"use client";

import { motion } from "framer-motion";
import AsciiProgressBar from "./AsciiProgressBar";
import TerminalLog from "./TerminalLog";

interface Phase3SynthesisProps {
  progress: number;
  logs: string[];
}

export default function Phase3Synthesis({
  progress,
  logs,
}: Phase3SynthesisProps) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.2 } }}
      className="flex min-h-screen flex-col px-8 py-12"
    >
      <div className="mb-6">
        <p className="opera-label text-black/50">
          S Y N T H E S I S
        </p>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center">
        <div className="w-full max-w-2xl">
          <p className="opera-label mb-4 text-black/40">
            S Y N T H E S I S &nbsp; P R O G R E S S
          </p>
          <AsciiProgressBar progress={progress} />

          <div className="mt-6 border-2 border-black shadow-[6px_6px_0px_rgba(0,0,0,1)] hover:shadow-[6px_6px_0px_var(--color-brand)] transition-shadow duration-300 bg-white p-6">
            <p className="opera-label mb-3 text-black/40">
              O P E R A T I O N S
            </p>
            <div className="space-y-1 font-mono text-xs text-black/70">
              {progress >= 10 && (
                <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                  CROSS_REFERENCING_SYMPTOM_LOG...
                </motion.p>
              )}
              {progress >= 30 && (
                <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                  ANALYZING_AUDIO_ANOMALIES...
                </motion.p>
              )}
              {progress >= 50 && (
                <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                  MATCHING_MANUAL_SECTIONS...
                </motion.p>
              )}
              {progress >= 70 && (
                <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                  GENERATING_REPAIR_INSTRUCTIONS...
                </motion.p>
              )}
              {progress >= 90 && (
                <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                  GENERATING_VISUAL_SCHEMATICS...
                </motion.p>
              )}
            </div>
          </div>
        </div>
      </div>

      <TerminalLog logs={logs} />
    </motion.div>
  );
}
