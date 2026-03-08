"use client";

import { useRef, useEffect } from "react";
import DecryptedText from "@/components/ui/DecryptedText";

interface TerminalLogProps {
  logs: string[];
  speedMultiplier?: number;
}

export default function TerminalLog({ logs, speedMultiplier = 1 }: TerminalLogProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [logs]);

  return (
    <div
      ref={containerRef}
      className="opera-border mt-4 h-40 overflow-y-auto bg-white p-4 font-mono text-xs"
    >
      {logs.map((log, i) => (
        <div key={`${log}-${i}`} className="mb-1">
          <span className="mr-2 text-black/30">
            {String(i).padStart(3, "0")}
          </span>
          <DecryptedText
            text={log}
            animateOn="view"
            sequential
            speed={speedMultiplier !== 1 ? 30 / speedMultiplier : 30}
            characters="0123456789ABCDEF_."
            className="text-black"
            encryptedClassName="text-black/30"
          />
        </div>
      ))}
    </div>
  );
}
