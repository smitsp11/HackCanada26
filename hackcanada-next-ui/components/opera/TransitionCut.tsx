"use client";

import { useEffect } from "react";
import { motion } from "framer-motion";
import { TIMING } from "@/lib/constants";

interface TransitionCutProps {
  onComplete: () => void;
}

export default function TransitionCut({ onComplete }: TransitionCutProps) {
  useEffect(() => {
    const timer = setTimeout(onComplete, TIMING.CUT_HOLD_MS);
    return () => clearTimeout(timer);
  }, [onComplete]);

  return (
    <motion.div
      initial={{ opacity: 1 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: TIMING.CUT_FADE_DURATION }}
      className="fixed inset-0 z-50 h-screen w-screen bg-black"
    />
  );
}
