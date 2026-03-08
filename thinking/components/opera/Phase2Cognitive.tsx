"use client";

import { useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import MediaSlot from "./MediaSlot";
import TerminalLog from "./TerminalLog";
import ScrambledText from "@/components/ui/ScrambledText";

interface Phase2CognitiveProps {
  slotUrls: [string | null, string | null, string | null, string | null];
  deviceId: string | null;
  manualMatch: { id: string; title: string } | null;
  logs: string[];
  onManualReady: () => void;
}

export default function Phase2Cognitive({
  slotUrls,
  deviceId,
  manualMatch,
  logs,
  onManualReady,
}: Phase2CognitiveProps) {
  const hasTriggeredRef = useRef(false);

  useEffect(() => {
    if (manualMatch && !hasTriggeredRef.current) {
      hasTriggeredRef.current = true;
      const timer = setTimeout(onManualReady, 1500);
      return () => clearTimeout(timer);
    }
  }, [manualMatch, onManualReady]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.2 } }}
      className="flex min-h-screen flex-col px-8 py-6"
    >
      <div className="mb-4">
        <p className="opera-label text-black/50">
          C O G N I T I V E &nbsp; E N G I N E
        </p>
      </div>

      {/* Reference strip -- slots shrink to thin bar */}
      <div className="mb-8 grid grid-cols-4 gap-2">
        {[0, 1, 2, 3].map((i) => (
          <MediaSlot
            key={i}
            index={i}
            status="complete"
            url={slotUrls[i]}
            compact
          />
        ))}
      </div>

      {/* Terminal area */}
      <div className="flex flex-1 flex-col items-center justify-center">
        {/* Device identification scramble */}
        <div className="opera-border opera-shadow opera-hover mb-8 w-full max-w-2xl bg-white p-8">
          <p className="opera-label mb-4 text-black/40">
            D E V I C E &nbsp; S I G N A T U R E
          </p>
          {deviceId ? (
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="font-mono text-lg font-bold tracking-wide text-black"
            >
              MATCH_FOUND: {deviceId}
            </motion.p>
          ) : (
            <ScrambledText
              radius={150}
              duration={1.2}
              speed={0.5}
              scrambleChars=".:#@█░▒▓"
              className="tracking-wide"
            >
              SCANNING_DEVICE_SIGNATURE...
            </ScrambledText>
          )}
        </div>

        {/* Manual card slam */}
        <AnimatePresence>
          {manualMatch && (
            <motion.div
              initial={{ scale: 1.5, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ duration: 0.3, ease: "easeOut" }}
              className="opera-border opera-shadow opera-hover mb-8 w-full max-w-2xl bg-white p-8"
            >
              <p className="opera-label mb-2 text-black/40">
                M A N U A L &nbsp; L O C A T E D
              </p>
              <p className="font-mono text-sm font-bold text-black">
                {manualMatch.title}
              </p>
              <p className="mt-1 font-mono text-xs text-black/50">
                ID: {manualMatch.id}
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <TerminalLog logs={logs} />
    </motion.div>
  );
}
