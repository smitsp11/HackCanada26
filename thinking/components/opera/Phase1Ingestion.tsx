"use client";

import { motion } from "framer-motion";
import type { SlotStatus } from "@/hooks/useOperaReducer";
import MediaSlot from "./MediaSlot";
import AudioWaveform from "./AudioWaveform";
import TerminalLog from "./TerminalLog";
import { TIMING } from "@/lib/constants";

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
    transition: { duration: 0.3, ease: "easeOut" },
  },
};

export default function Phase1Ingestion({
  slots,
  slotUrls,
  logs,
}: Phase1IngestionProps) {
  const audioSlotActive = slots[3] === "processing";

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

      <AudioWaveform active={audioSlotActive} />

      <TerminalLog logs={logs} />
    </motion.div>
  );
}
