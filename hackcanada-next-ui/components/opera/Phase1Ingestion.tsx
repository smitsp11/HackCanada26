"use client";

import { motion } from "framer-motion";
import type { SlotStatus } from "@/hooks/useOperaReducer";
import MediaSlot from "./MediaSlot";
import TerminalLog from "./TerminalLog";
import { TIMING, SLOT_LABELS } from "@/lib/constants";

interface Phase1IngestionProps {
  slots: [SlotStatus, SlotStatus, SlotStatus, SlotStatus];
  slotUrls: [string | null, string | null, string | null, string | null];
  logs: string[];
}

const containerVariants = {
  hidden: {},
  visible: {
    transition: {
      staggerChildren: TIMING.STAGGER_DELAY,
    },
  },
  exit: {
    opacity: 0,
    transition: { duration: 0.2 },
  },
};

const slotVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.3, ease: "easeOut" as const },
  },
};

const SEGMENT_LABELS = ["FRAME_01", "FRAME_02", "FRAME_03", "VIDEO"];

function IngestionProgress({ slots }: { slots: [SlotStatus, SlotStatus, SlotStatus, SlotStatus] }) {
  const lockedCount = slots.filter((s) => s === "complete").length;

  return (
    <div className="mt-4 border-2 border-black bg-white p-3 flex items-center gap-3">
      <div className="flex flex-1 gap-1">
        {slots.map((status, i) => (
          <motion.div
            key={i}
            className="relative flex-1 h-6 border border-black/20 overflow-hidden"
            animate={{
              backgroundColor:
                status === "complete"
                  ? "var(--color-brand)"
                  : status === "processing"
                    ? "rgba(0,0,0,0.08)"
                    : "rgba(0,0,0,0.03)",
            }}
            transition={{ duration: 0.3 }}
          >
            {status === "processing" && (
              <motion.div
                className="absolute inset-0 bg-black/10"
                animate={{ opacity: [0.1, 0.3, 0.1] }}
                transition={{ duration: 1, repeat: Infinity, ease: "easeInOut" }}
              />
            )}
            <span className="absolute inset-0 flex items-center justify-center font-mono text-[9px] font-bold tracking-wider"
              style={{ color: status === "complete" ? "white" : "rgba(0,0,0,0.3)" }}
            >
              {SEGMENT_LABELS[i]}
            </span>
          </motion.div>
        ))}
      </div>
      <span className="font-mono text-xs font-bold text-black/60 whitespace-nowrap">
        {lockedCount} / 4&nbsp; LOCKED
      </span>
    </div>
  );
}

export default function Phase1Ingestion({
  slots,
  slotUrls,
  logs,
}: Phase1IngestionProps) {
  return (
    <motion.div
      variants={containerVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
      className="flex min-h-screen flex-col px-8 py-12"
    >
      <div className="mb-6">
        <p className="opera-label text-black/50">
          V I S U A L &nbsp; I N G E S T I O N
        </p>
      </div>

      <motion.div className="grid grid-cols-4 gap-4" variants={containerVariants}>
        {slots.map((status, i) => (
          <motion.div key={i} variants={slotVariants}>
            <MediaSlot
              index={i}
              status={status}
              url={slotUrls[i]}
            />
          </motion.div>
        ))}
      </motion.div>

      <IngestionProgress slots={slots} />

      <TerminalLog logs={logs} />
    </motion.div>
  );
}
