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

  const handleExecute = (finalSymptom: string) => {
    if (assets.length === 0 && !finalSymptom.trim()) return;

    const slotOrder = ["model", "additional", "video"] as const;
    const urls = slotOrder.map((key) => {
      const match = assets.find((a) => a.slot === key);
      return match?.secure_url ?? "";
    }) as [string, string, string];

    const makeModel = identifiedProduct?.product
      ? `${identifiedProduct.product.company} ${identifiedProduct.product.display_name || identifiedProduct.product.model_number}`
      : identifiedProduct?.parsedBrand || identifiedProduct?.parsedModel
        ? [identifiedProduct.parsedBrand, identifiedProduct.parsedModel].filter(Boolean).join(" ")
        : undefined;

    sessionStorage.setItem(
      "opera-assets",
      JSON.stringify({ urls, symptom: finalSymptom, makeModel })
    );

    router.push("/diagnostic");
  };

  return (
    <div className="h-screen bg-transparent text-black font-sans flex flex-col overflow-hidden">
      {showIntro && <OperaIntro onComplete={handleIntroComplete} />}
      <Header view="input" onAbort={() => {}} />

      <InputScreen
        setAssets={setAssets}
        onExecute={handleExecute}
        onProductIdentified={handleProductIdentified}
      />

      <Footer />
    </div>
  );
}
