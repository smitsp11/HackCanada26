"use client";

import { motion } from "framer-motion";
import type { RepairStep } from "@/lib/events";
import { TIMING } from "@/lib/constants";

interface ResultPaneProps {
  steps: RepairStep[];
  logs: string[];
}

const stepsContainerVariants = {
  hidden: {},
  visible: {
    transition: {
      staggerChildren: 0.1,
    },
  },
};

const stepVariants = {
  hidden: { opacity: 0, y: 10 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.3 },
  },
};

export default function ResultPane({ steps, logs }: ResultPaneProps) {
  const stepsWithSchematics = steps.filter((s) => s.schematicUrl);
  const allSteps = steps;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="flex min-h-screen"
    >
      {/* Left panel -- repair steps */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.3, delay: 0.1 }}
        className="flex-1 overflow-y-auto px-8 py-12"
      >
        <p className="opera-label mb-2 text-black/50">
          D I A G N O S T I C &nbsp; C O M P L E T E
        </p>
        <h2 className="mb-8 font-sans text-3xl font-black tracking-tight text-black">
          REPAIR INSTRUCTIONS
        </h2>

        <motion.div
          variants={stepsContainerVariants}
          initial="hidden"
          animate="visible"
          className="space-y-4"
        >
          {allSteps.map((step) => (
            <motion.div
              key={step.id}
              variants={stepVariants}
              className="opera-border bg-white p-6"
            >
              <div className="mb-2 flex items-baseline gap-3">
                <span className="font-mono text-2xl font-black text-black">
                  {String(step.id).padStart(2, "0")}
                </span>
                <div className="h-px flex-1 bg-black/10" />
              </div>
              <p className="font-sans text-sm leading-relaxed text-black/80">
                {step.instruction}
              </p>
            </motion.div>
          ))}
        </motion.div>

        {/* Terminal log at bottom */}
        <div className="mt-8 opera-border h-32 overflow-y-auto bg-white p-4 font-mono text-xs">
          {logs.slice(-8).map((log, i) => (
            <p key={i} className="text-black/40">
              {log}
            </p>
          ))}
        </div>
      </motion.div>

      {/* Right sidebar -- schematics */}
      <motion.div
        initial={{ x: "100%" }}
        animate={{ x: 0 }}
        transition={{
          duration: TIMING.SIDEBAR_SLIDE_DURATION,
          ease: "easeOut",
        }}
        className="w-96 shrink-0 overflow-y-auto border-l border-black bg-gray-50 px-6 py-12"
      >
        <p className="opera-label mb-6 text-black/50">
          V I S U A L &nbsp; S C H E M A T I C S
        </p>

        {stepsWithSchematics.length > 0 ? (
          <div className="space-y-6">
            {stepsWithSchematics.map((step) => (
              <div key={step.id} className="opera-border opera-shadow bg-white p-4">
                <p className="opera-label mb-2 text-black/40">
                  S T E P &nbsp; {String(step.id).padStart(2, "0")}
                </p>
                <img
                  src={step.schematicUrl!}
                  alt={`Schematic for step ${step.id}`}
                  className="h-auto w-full"
                />
              </div>
            ))}
          </div>
        ) : (
          <div className="flex h-48 items-center justify-center opera-border bg-white">
            <p className="font-mono text-xs text-black/30">
              NO SCHEMATICS AVAILABLE
            </p>
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}
