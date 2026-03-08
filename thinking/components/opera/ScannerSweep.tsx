"use client";

import { IS_VISUAL_TEST_MODE, TIMING } from "@/lib/constants";

interface ScannerSweepProps {
  active: boolean;
}

export default function ScannerSweep({ active }: ScannerSweepProps) {
  if (!active) return null;

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      <div
        className="absolute left-0 h-0.5 w-full bg-black/80"
        style={{
          animation: IS_VISUAL_TEST_MODE
            ? "none"
            : `scanSweep ${TIMING.SCANNER_LOOP_DURATION_S}s linear infinite`,
          top: IS_VISUAL_TEST_MODE ? "50%" : undefined,
        }}
      />
    </div>
  );
}
