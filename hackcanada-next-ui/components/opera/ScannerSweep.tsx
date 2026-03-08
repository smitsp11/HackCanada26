"use client";

import { IS_VISUAL_TEST_MODE, TIMING } from "@/lib/constants";

interface ScannerSweepProps {
  active: boolean;
  /** 0.8 = 80% speed (slower). Duration = SCANNER_LOOP_DURATION_S / speedMultiplier */
  speedMultiplier?: number;
}

export default function ScannerSweep({ active, speedMultiplier = 1 }: ScannerSweepProps) {
  if (!active) return null;

  const duration = speedMultiplier !== 1
    ? TIMING.SCANNER_LOOP_DURATION_S / speedMultiplier
    : TIMING.SCANNER_LOOP_DURATION_S;

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      <div
        className="absolute left-0 h-0.5 w-full bg-black/80"
        style={{
          animation: IS_VISUAL_TEST_MODE
            ? "none"
            : `scanSweep ${duration}s linear infinite`,
          top: IS_VISUAL_TEST_MODE ? "50%" : undefined,
        }}
      />
    </div>
  );
}
