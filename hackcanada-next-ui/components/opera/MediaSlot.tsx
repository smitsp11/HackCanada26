"use client";

import { motion } from "framer-motion";
import type { SlotStatus } from "@/hooks/useOperaReducer";
import ScannerSweep from "./ScannerSweep";
import Noise from "@/components/ui/Noise";
import { IS_VISUAL_TEST_MODE, SLOT_LABELS } from "@/lib/constants";

interface MediaSlotProps {
  index: number;
  status: SlotStatus;
  url: string | null;
  compact?: boolean;
}

function SlotMedia({ index, url, className }: { index: number; url: string; className: string }) {
  const isVideo = index === 3;
  if (isVideo) {
    return <video src={url} className={className} muted autoPlay loop playsInline />;
  }
  return <img src={url} alt={`Frame ${index}`} className={className} />;
}

export default function MediaSlot({
  index,
  status,
  url,
  compact = false,
}: MediaSlotProps) {
  const isScanning = status === "processing";
  const isDone = status === "complete";

  if (compact) {
    return (
      <motion.div
        layoutId={`slot-${index}`}
        className="opera-border relative flex h-16 items-center justify-center overflow-hidden bg-white"
      >
        {url && (
          <SlotMedia index={index} url={url} className="h-full w-full object-cover opacity-60" />
        )}
        <span className="opera-label absolute text-[0.6rem] text-black/50">
          {SLOT_LABELS[index]}
        </span>
      </motion.div>
    );
  }

  return (
    <motion.div
      layoutId={`slot-${index}`}
      className={`opera-border relative flex aspect-square items-center justify-center overflow-hidden bg-white transition-opacity ${
        isDone ? "opacity-70" : "opacity-100"
      }`}
    >
      {url && (
        <SlotMedia index={index} url={url} className="h-full w-full object-cover" />
      )}

      {!url && (
        <span className="opera-label text-black/30">
          {SLOT_LABELS[index]}
        </span>
      )}

      <ScannerSweep active={isScanning} />

      {isScanning && !IS_VISUAL_TEST_MODE && (
        <Noise
          patternAlpha={15}
          patternRefreshInterval={2}
          patternSize={200}
        />
      )}

      {isDone && (
        <motion.div
          initial={{ scale: 0 }}
          animate={{ scale: [0, 1.2, 1] }}
          transition={{ duration: 0.3, ease: "easeOut" }}
          className="absolute right-2 top-2 bg-black px-2 py-0.5 font-mono text-[10px] font-bold text-white"
        >
          [OK]
        </motion.div>
      )}
    </motion.div>
  );
}
