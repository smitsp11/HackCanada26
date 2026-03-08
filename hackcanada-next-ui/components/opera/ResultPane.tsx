"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import type { RepairStep } from "@/lib/events";
import { PassbookStack, type StackLayout } from "./PassbookStack";
import { TIMING } from "@/lib/constants";

interface ResultPaneProps {
  steps: RepairStep[];
  logs: string[];
  deviceId?: string | null;
  symptom?: string;
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

export default function ResultPane({ steps, logs, deviceId, symptom }: ResultPaneProps) {
  const router = useRouter();
  const [animationsComplete, setAnimationsComplete] = useState(false);
  const stepsWithSchematics = steps.filter((s) => s.schematicUrl);
  const allSteps = steps;
  const lastIndex = Math.max(0, stepsWithSchematics.length - 1);
  const [topIndex, setTopIndex] = useState(0);
  const stackLayout: StackLayout = "diagonal-fan";
  const safeTopIndex = Math.min(topIndex, lastIndex);

  const handleBegin = () => {
    sessionStorage.setItem(
      "opera-steps",
      JSON.stringify({
        steps,
        equipment: deviceId ?? "Device",
        fault: symptom ?? "Repair required",
      })
    );
    router.push("/steps");
  };

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
          onAnimationComplete={() => setAnimationsComplete(true)}
          className="space-y-4"
        >
          {allSteps.map((step) => (
            <motion.div
              key={step.id}
              variants={stepVariants}
              className="border-2 border-black shadow-[6px_6px_0px_rgba(0,0,0,1)] hover:shadow-[6px_6px_0px_var(--color-brand)] transition-shadow duration-300 bg-white p-6"
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
        <div className="opera-label mb-6 text-black/50">
          <p>V I S U A L</p>
          <p>S C H E M A T I C S</p>
        </div>

        {stepsWithSchematics.length > 0 ? (
          <PassbookStack
            steps={stepsWithSchematics}
            activeIndex={safeTopIndex}
            onSelect={setTopIndex}
            layout={stackLayout}
          />
        ) : (
          <div className="flex h-48 items-center justify-center opera-border bg-white">
            <p className="font-mono text-xs text-black/30">
              NO SCHEMATICS AVAILABLE
            </p>
          </div>
        )}
      </motion.div>

      {animationsComplete && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.3 }}
          className="fixed bottom-6 right-8"
        >
          <button
            onClick={handleBegin}
            className="border-2 border-black bg-white px-6 py-3 font-mono text-sm font-bold tracking-[0.2em] uppercase shadow-[6px_6px_0px_rgba(0,0,0,1)] hover:shadow-[6px_6px_0px_var(--color-brand)] transition-shadow duration-200"
          >
            Begin
          </button>
        </motion.div>
      )}
    </motion.div>
  );
}
