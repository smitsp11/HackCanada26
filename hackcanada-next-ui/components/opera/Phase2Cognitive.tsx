"use client";

import { useEffect, useMemo, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import TerminalLog from "./TerminalLog";
import ScrambledText from "@/components/ui/ScrambledText";
import { getDemoEnhancedUrls } from "@/lib/demo-enhanced-urls";
import { getEnhancedSlotUrls } from "@/lib/cloudinary-enhance";

interface Phase2CognitiveProps {
  slotUrls: [string | null, string | null, string | null];
  useDemoAssets?: boolean;
  deviceId: string | null;
  manualMatch: { id: string; title: string } | null;
  logs: string[];
  onManualReady: () => void;
}

function Thumbnail({ url, index, matched }: { url: string | null; index: number; matched: boolean }) {
  const isVideo = index === 2;
  return (
    <motion.div
      className="relative w-12 h-12 border border-black/20 overflow-hidden bg-black/5"
      animate={{
        borderColor: matched ? "var(--color-brand)" : "rgba(0,0,0,0.2)",
        borderWidth: matched ? 2 : 1,
      }}
      transition={{ duration: 0.4, delay: index * 0.1 }}
    >
      {url && (
        isVideo
          ? <video src={url} className="w-full h-full object-cover" muted autoPlay loop playsInline />
          : <img src={url} alt={`Asset ${index + 1}`} className="w-full h-full object-cover" />
      )}
    </motion.div>
  );
}

export default function Phase2Cognitive({
  slotUrls,
  useDemoAssets = false,
  deviceId,
  manualMatch,
  logs,
  onManualReady,
}: Phase2CognitiveProps) {
  const hasTriggeredRef = useRef(false);

  const displayUrls = useMemo(() => {
    if (useDemoAssets) return getDemoEnhancedUrls();
    return getEnhancedSlotUrls(slotUrls);
  }, [useDemoAssets, slotUrls]);

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

      <div className="flex flex-1 flex-col items-center justify-center">
        {/* Device Signature card with embedded thumbnails */}
        <div className="border-2 border-black shadow-[6px_6px_0px_rgba(0,0,0,1)] hover:shadow-[6px_6px_0px_var(--color-brand)] transition-shadow duration-300 mb-8 w-full max-w-2xl bg-white p-8">
          <div className="flex items-start justify-between gap-6">
            <div className="flex-1 min-w-0">
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

            <div className="flex flex-col items-center gap-1.5 shrink-0">
              <div className="flex justify-center">
                <Thumbnail url={displayUrls[0]} index={0} matched={!!deviceId} />
              </div>
              <div className="flex gap-1.5 justify-center">
                <Thumbnail url={displayUrls[1]} index={1} matched={!!deviceId} />
                <Thumbnail url={displayUrls[2]} index={2} matched={!!deviceId} />
              </div>
            </div>
          </div>
        </div>

        {/* Manual card slam */}
        <AnimatePresence>
          {manualMatch && (
            <motion.div
              initial={{ scale: 1.5, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ duration: 0.3, ease: "easeOut" }}
              className="border-2 border-black shadow-[6px_6px_0px_rgba(0,0,0,1)] hover:shadow-[6px_6px_0px_var(--color-brand)] transition-shadow duration-300 mb-8 w-full max-w-2xl bg-white p-8"
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
