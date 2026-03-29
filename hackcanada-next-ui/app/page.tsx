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
  const [assets, setAssets] = useState<any[]>([]);
  const [showIntro, setShowIntro] = useState<boolean | null>(null);
  const [identifiedProduct, setIdentifiedProduct] = useState<IdentifiedProduct | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    setShowIntro(!sessionStorage.getItem(INTRO_SEEN_KEY));
  }, []);

  const handleIntroComplete = () => {
    sessionStorage.setItem(INTRO_SEEN_KEY, "1");
    setShowIntro(false);
  };

  const handleProductIdentified = useCallback((result: IdentifiedProduct | null) => {
    setIdentifiedProduct(result);
  }, []);

  const handleExecute = async (finalSymptom: string) => {
    if (assets.length === 0 && !finalSymptom.trim()) return;
    if (isSubmitting) return;

    setIsSubmitting(true);

    try {
      const slotOrder = ["model", "additional", "video"] as const;

      const makeModel = identifiedProduct?.product
        ? `${identifiedProduct.product.company} ${identifiedProduct.product.display_name || identifiedProduct.product.model_number}`
        : identifiedProduct?.parsedBrand || identifiedProduct?.parsedModel
          ? [identifiedProduct.parsedBrand, identifiedProduct.parsedModel].filter(Boolean).join(" ")
          : undefined;

      // Step 1: Create case
      const caseRes = await fetch("/api/cases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appliance_type_hint: makeModel || undefined,
        }),
      });

      if (!caseRes.ok) {
        throw new Error("Failed to create case");
      }

      const { case_id: caseId } = await caseRes.json();

      // Step 2: Submit input (assets + description + metadata)
      const assetPayload = slotOrder
        .map((key) => {
          const match = assets.find((a) => a.slot === key);
          if (!match) return null;
          return {
            cloudinary_url: match.secure_url,
            cloudinary_public_id: match.public_id,
            slot_key: key,
            asset_type: key === "video" ? "video" : "image",
          };
        })
        .filter(Boolean);

      const metadata: Record<string, string> = {};
      if (identifiedProduct?.parsedBrand) metadata.brand = identifiedProduct.parsedBrand;
      if (identifiedProduct?.parsedModel) metadata.model = identifiedProduct.parsedModel;

      const inputRes = await fetch(`/api/cases/${caseId}/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: finalSymptom,
          metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
          assets: assetPayload,
        }),
      });

      if (!inputRes.ok) {
        throw new Error("Failed to submit case input");
      }

      // Step 3: Navigate with caseId
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
        setAssets={setAssets}
        onExecute={handleExecute}
        onProductIdentified={handleProductIdentified}
        isSubmitting={isSubmitting}
      />

      <Footer />
    </div>
  );
}
