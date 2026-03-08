"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Header } from "./components/Header";
import { Footer } from "./components/Footer";
import { InputScreen } from "./components/InputScreen";
import { OperaIntro } from "./components/OperaIntro";

const INTRO_SEEN_KEY = "opera-intro-seen";

export default function Home() {
  const router = useRouter();
  const [assets, setAssets] = useState<any[]>([]);
  const [showIntro, setShowIntro] = useState<boolean | null>(null);

  useEffect(() => {
    setShowIntro(!sessionStorage.getItem(INTRO_SEEN_KEY));
  }, []);

  const handleIntroComplete = () => {
    sessionStorage.setItem(INTRO_SEEN_KEY, "1");
    setShowIntro(false);
  };

  const handleExecute = (finalSymptom: string) => {
    if (assets.length === 0 && !finalSymptom.trim()) return;

    const slotOrder = ["model", "additional", "video"] as const;
    const urls = slotOrder.map((key) => {
      const match = assets.find((a) => a.slot === key);
      return match?.secure_url ?? "";
    }) as [string, string, string];

    sessionStorage.setItem(
      "opera-assets",
      JSON.stringify({ urls, symptom: finalSymptom })
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
      />

      <Footer />
    </div>
  );
}
