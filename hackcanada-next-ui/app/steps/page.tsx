"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Header } from "../components/Header";
import { Footer } from "../components/Footer";
import { DiagnosticDashboard } from "../components/DiagnosticDashboard";
import type { RepairStep } from "@/lib/events";

interface OperaStepsData {
  steps: RepairStep[];
  equipment?: string;
  fault?: string;
}

type MockStep = {
  step: number;
  action: string;
  caution: string;
  image_url: string;
};

function toMockStep(s: RepairStep): MockStep {
  return {
    step: s.id,
    action: s.instruction,
    caution: "None",
    image_url:
      s.schematicUrl ||
      `https://placehold.co/800x600/f4f4f5/09090b?text=FIG.+${String(s.id).padStart(2, "0")}`,
  };
}

export default function StepsPage() {
  const router = useRouter();
  const [data, setData] = useState<OperaStepsData | null>(null);

  useEffect(() => {
    const raw = sessionStorage.getItem("opera-steps");
    if (!raw) {
      router.replace("/");
      return;
    }
    try {
      setData(JSON.parse(raw));
    } catch {
      router.replace("/");
    }
  }, [router]);

  if (!data) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="font-mono text-sm text-black/50">Loading steps…</p>
      </div>
    );
  }

  const mockSteps = data.steps.map(toMockStep);
  const mockDiagnosis = {
    equipment: data.equipment ?? "Device",
    fault: data.fault ?? "Repair required",
  };

  return (
    <div className="min-h-screen bg-transparent text-black font-sans flex flex-col">
      <Header view="diagnostic" onAbort={() => router.push("/")} />
      <DiagnosticDashboard
        assets={[]}
        mockDiagnosis={mockDiagnosis}
        mockSteps={mockSteps}
      />
      <Footer />
    </div>
  );
}
