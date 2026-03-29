"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Header } from "./components/Header";
import { Footer } from "./components/Footer";
import { InputScreen, type IdentifiedProduct } from "./components/InputScreen";
import { OperaIntro } from "./components/OperaIntro";

const INTRO_SEEN_KEY = "opera-intro-seen";

export default function Home() {
  const router = useRouter();
  const [caseId, setCaseId] = useState<string | null>(null);
  const [showIntro, setShowIntro] = useState<boolean | null>(null);
  const [identifiedProduct, setIdentifiedProduct] = useState<IdentifiedProduct | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    setShowIntro(!sessionStorage.getItem(INTRO_SEEN_KEY));
  }, []);

  // Create case eagerly so signed-URL uploads can register against it
  // before the user clicks "Execute Diagnostic".
  // TODO(cleanup): Abandoned sessions will leave orphaned case rows with
  // status='created' and zero assets. Add a periodic cleanup job or DB
  // cron to delete cases older than N hours that never progressed past
  // 'created'. This is acceptable for MVP.
  useEffect(() => {
    let cancelled = false;

    async function createCase() {
      try {
        const res = await fetch("/api/cases", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        if (!res.ok) throw new Error("Failed to create case");
        const data = await res.json();
        if (!cancelled) setCaseId(data.case_id);
      } catch (err) {
        console.error("Early case creation failed:", err);
      }
    }

    createCase();
    return () => { cancelled = true; };
  }, []);

  const handleIntroComplete = () => {
    sessionStorage.setItem(INTRO_SEEN_KEY, "1");
    setShowIntro(false);
  };

  const handleProductIdentified = useCallback((result: IdentifiedProduct | null) => {
    setIdentifiedProduct(result);
  }, []);

  const handleExecute = async (finalSymptom: string) => {
    if (!caseId || !finalSymptom.trim()) return;
    if (isSubmitting) return;

    setIsSubmitting(true);

    try {
      const makeModel = identifiedProduct?.product
        ? `${identifiedProduct.product.company} ${identifiedProduct.product.display_name || identifiedProduct.product.model_number}`
        : identifiedProduct?.parsedBrand || identifiedProduct?.parsedModel
          ? [identifiedProduct.parsedBrand, identifiedProduct.parsedModel].filter(Boolean).join(" ")
          : undefined;

      // Update case with appliance hint if we have one
      if (makeModel) {
        await fetch(`/api/cases/${caseId}/input`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            description: finalSymptom,
            metadata: {
              brand: identifiedProduct?.parsedBrand || undefined,
              model: identifiedProduct?.parsedModel || undefined,
            },
            assets: [],
          }),
        });
      } else {
        await fetch(`/api/cases/${caseId}/input`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            description: finalSymptom,
            assets: [],
          }),
        });
      }

      router.push(`/diagnostic?caseId=${caseId}`);
    } catch (error) {
      console.error("Execute diagnostic failed:", error);
      setIsSubmitting(false);
    }
  };

  return (
    <div className="h-screen bg-transparent text-black font-sans flex flex-col overflow-hidden">
      {showIntro && <OperaIntro onComplete={handleIntroComplete} />}
      <Header view="input" onAbort={() => {}} />

      <InputScreen
        caseId={caseId}
        onExecute={handleExecute}
        onProductIdentified={handleProductIdentified}
        isSubmitting={isSubmitting}
      />

      <Footer />
    </div>
  );
}
