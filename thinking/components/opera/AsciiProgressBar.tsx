"use client";

interface AsciiProgressBarProps {
  progress: number;
}

export default function AsciiProgressBar({ progress }: AsciiProgressBarProps) {
  const clamped = Math.max(0, Math.min(100, progress));
  const filled = Math.floor(clamped / 10);
  const bar = "\u2588".repeat(filled) + "\u2591".repeat(10 - filled);

  return (
    <div className="opera-border bg-white p-4 font-mono text-sm">
      <span className="text-black/40">[</span>
      <span className="text-black">{bar}</span>
      <span className="text-black/40">]</span>
      <span className="ml-3 text-black">
        {String(Math.round(clamped)).padStart(3, " ")}%
      </span>
    </div>
  );
}
