"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import OperaShell from "@/components/opera/OperaShell";
import { DEMO_ASSET_URLS, DEFAULT_DEMO_SYMPTOM } from "@/lib/demo-assets";

interface OperaAssets {
  urls: [string, string, string];
  symptom: string;
  makeModel?: string;
}

function DiagnosticContent() {
  const searchParams = useSearchParams();
  const caseId = searchParams.get("caseId");
  const useDemoAssets = !caseId;
  const assets: OperaAssets | null = caseId
    ? null
    : {
        urls: [...DEMO_ASSET_URLS],
        symptom: DEFAULT_DEMO_SYMPTOM,
      };

  if (!caseId && !assets) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="font-mono text-sm text-black/50">Loading diagnostic...</p>
      </div>
    );
  }

  if (caseId) {
    return (
      <main className="relative min-h-screen w-full overflow-hidden">
        <OperaShell caseId={caseId} />
      </main>
    );
  }

  if (!assets) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="font-mono text-sm text-black/50">Loading diagnostic...</p>
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

export default function DiagnosticPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <p className="font-mono text-sm text-black/50">Loading diagnostic...</p>
        </div>
      }
    >
      <DiagnosticContent />
    </Suspense>
  );
}
