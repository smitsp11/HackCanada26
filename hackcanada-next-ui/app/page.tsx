"use client";

import { useState } from "react";
import { Header } from "./components/Header";
import { Footer } from "./components/Footer";
import { InputScreen } from "./components/InputScreen";
import { DiagnosticDashboard } from "./components/DiagnosticDashboard";

// Mock Data
const MOCK_DIAGNOSIS = { equipment: "Carrier Furnace 59SC6A", fault: "Faulty Igniter Assembly" };
const MOCK_STEPS = [
  { step: 1, action: "Turn off power at the main breaker before proceeding.", caution: "HIGH VOLTAGE. Ensure system is dead.", image_url: "https://placehold.co/800x600/f4f4f5/09090b?text=FIG.+01" },
  { step: 2, action: "Remove the front lower panel by unscrewing the 4 corner bolts.", caution: "None.", image_url: "https://placehold.co/800x600/f4f4f5/09090b?text=FIG.+02" }
];

export default function Home() {
  const [view, setView] = useState<"input" | "diagnostic">("input");
  const [assets, setAssets] = useState<any[]>([]);
  const [symptom, setSymptom] = useState("");

  const handleExecute = (finalSymptom: string) => {
    if (assets.length === 0 && !finalSymptom.trim()) return;
    
    setSymptom(finalSymptom); // Save it so the dashboard can see it
    console.log("SENDING TO BACKEND:", { assets, symptom: finalSymptom });
    setView("diagnostic");
  };

  // NEW: The state wiper to prevent infinite loops
  const handleAbort = () => {
    setSymptom("");
    setAssets([]);
    setView("input");
  };

  return (
    <div className="h-screen bg-transparent text-black font-sans flex flex-col overflow-hidden">
      <Header view={view} onAbort={handleAbort} />
      
      {view === "input" ? (
        <InputScreen 
          assets={assets} 
          setAssets={setAssets} 
          onExecute={handleExecute} 
        />
      ) : (
        <DiagnosticDashboard 
          assets={assets} 
          mockDiagnosis={MOCK_DIAGNOSIS} 
          mockSteps={MOCK_STEPS} 
        />
      )}

      <Footer />
    </div>
  );
}