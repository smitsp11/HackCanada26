"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";

const LOGO = "Opera AI";
const TYPE_DELAY_MS = 125; /* 0.8× speed (100 / 0.8) */
const POST_TYPE_PAUSE_MS = 400;

export function OperaIntro({
  onComplete,
}: {
  onComplete: () => void;
}) {
  const [phase, setPhase] = useState<"typing" | "asset" | "moving" | "done">("typing");
  const [typedLength, setTypedLength] = useState(0);
  const [showCursor, setShowCursor] = useState(true);

  // Typewriter
  useEffect(() => {
    if (phase !== "typing") return;
    if (typedLength >= LOGO.length) {
      setShowCursor(false);
      setPhase("asset");
      return;
    }
    const t = setTimeout(() => setTypedLength((n) => n + 1), TYPE_DELAY_MS);
    return () => clearTimeout(t);
  }, [phase, typedLength]);

  // Asset pause, then move
  useEffect(() => {
    if (phase !== "asset") return;
    const t = setTimeout(() => setPhase("moving"), POST_TYPE_PAUSE_MS);
    return () => clearTimeout(t);
  }, [phase]);

  const handleMoveComplete = () => {
    setPhase("done");
  };

  const handleOverlayFadeComplete = () => {
    onComplete();
  };

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center bg-white"
      initial={{ opacity: 1 }}
      animate={
        phase === "done"
          ? { opacity: 0 }
          : { opacity: 1 }
      }
      transition={{
        duration: 0.5,
        ease: "easeOut",
      }}
      onAnimationComplete={() => {
        if (phase === "done") handleOverlayFadeComplete();
      }}
    >
      <AnimatePresence mode="wait">
        {(phase === "typing" || phase === "asset" || phase === "moving" || phase === "done") && (
          <motion.h1
            key="logo"
            className="font-black tracking-tighter leading-none text-black text-4xl sm:text-5xl whitespace-nowrap"
            initial={{
              left: "50%",
              top: "50%",
              x: "-50%",
              y: "-50%",
            }}
            animate={
              phase === "moving" || phase === "done"
                ? {
                    left: 32,
                    top: 32,
                    x: 0,
                    y: 0,
                    transition: {
                      duration: 0.857, /* 0.7× speed (0.6 / 0.7) */
                      ease: [0.25, 0.46, 0.45, 0.94],
                    },
                  }
                : {
                    left: "50%",
                    top: "50%",
                    x: "-50%",
                    y: "-50%",
                  }
            }
            style={{
              position: "fixed",
            }}
            onAnimationComplete={() => {
              if (phase === "moving") handleMoveComplete();
            }}
          >
            {LOGO.slice(0, typedLength)}
            {showCursor && phase === "typing" && (
              <span className="inline-block w-0.5 h-[0.9em] bg-black ml-0.5 animate-pulse" />
            )}
          </motion.h1>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
