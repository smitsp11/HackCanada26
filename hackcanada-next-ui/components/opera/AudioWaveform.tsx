"use client";

import { IS_VISUAL_TEST_MODE } from "@/lib/constants";

interface AudioWaveformProps {
  active: boolean;
}

export default function AudioWaveform({ active }: AudioWaveformProps) {
  const pathD =
    "M0,25 Q10,10 20,25 T40,25 T60,25 T80,25 T100,25 T120,25 T140,25 T160,25 T180,25 T200,25 T220,25 T240,25 T260,25 T280,25 T300,25";

  return (
    <div className="opera-border mt-2 bg-white p-2">
      <svg
        viewBox="0 0 300 50"
        className="h-8 w-full"
        preserveAspectRatio="none"
      >
        <path
          d={pathD}
          fill="none"
          stroke="#000"
          strokeWidth="1.5"
          strokeDasharray="600"
          strokeDashoffset={active && !IS_VISUAL_TEST_MODE ? undefined : "0"}
          style={
            active && !IS_VISUAL_TEST_MODE
              ? {
                  animation: "waveformDraw 2s linear infinite",
                }
              : { strokeDashoffset: 0 }
          }
        />
      </svg>
    </div>
  );
}
