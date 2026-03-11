"use client";

import { useEffect, useState } from "react";
import OperaShell from "@/components/opera/OperaShell";
import { DEMO_ASSET_URLS, DEFAULT_DEMO_SYMPTOM } from "@/lib/demo-assets";

interface OperaAssets {
  urls: [string, string, string];
  symptom: string;
  makeModel?: string;
}

export default function DiagnosticPage() {
  const [assets, setAssets] = useState<OperaAssets | null>(null);
  const [useDemoAssets, setUseDemoAssets] = useState(false);

  useEffect(() => {
    const raw = sessionStorage.getItem("opera-assets");
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        setAssets(parsed);
        setUseDemoAssets(false);
        return;
      } catch {
        /* malformed – ignore */
      }
    }
    setAssets({
      urls: [...DEMO_ASSET_URLS],
      symptom: DEFAULT_DEMO_SYMPTOM,
    });
    setUseDemoAssets(true);
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
      <OperaShell
        assetUrls={assets.urls}
        symptom={assets.symptom}
        makeModel={assets.makeModel}
        useDemoAssets={useDemoAssets}
      />
    </main>
  );
}
