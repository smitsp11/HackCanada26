"use client";

import { useEffect, useState } from "react";
import OperaShell from "@/components/opera/OperaShell";

interface OperaAssets {
  urls: [string, string, string, string];
  symptom: string;
}

export default function DiagnosticPage() {
  const [assets, setAssets] = useState<OperaAssets | null>(null);

  useEffect(() => {
    const raw = sessionStorage.getItem("opera-assets");
    if (raw) {
      try {
        setAssets(JSON.parse(raw));
      } catch {
        /* malformed – ignore */
      }
    }
  }, []);

  if (!assets) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="font-mono text-sm text-black/50">Loading diagnostic…</p>
      </div>
    );
  }

  return (
    <main className="relative min-h-screen w-full overflow-hidden">
      <OperaShell assetUrls={assets.urls} symptom={assets.symptom} />
    </main>
  );
}
