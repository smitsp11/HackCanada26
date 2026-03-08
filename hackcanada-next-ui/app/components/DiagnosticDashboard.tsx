"use client";

import { useRef, useState } from "react";

type Diagnosis = {
  equipment: string;
  fault: string;
};

type StepData = {
  step: number;
  action: string;
  caution: string;
  image_url: string;
};

type ProcessApiResponse = {
  annotatedUrl?: string | null;
  error?: string;
};

interface DiagnosticDashboardProps {
  assets: unknown[];
  mockDiagnosis: Diagnosis;
  mockSteps: StepData[];
}

export function DiagnosticDashboard({ assets, mockDiagnosis, mockSteps }: DiagnosticDashboardProps) {
  const [currentStep, setCurrentStep] = useState(0);
  const [annotatedByStep, setAnnotatedByStep] = useState<Record<number, string>>({});
  const [isProcessing, setIsProcessing] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const activeStepData = mockSteps[currentStep];
  const activeImageUrl = annotatedByStep[currentStep] || activeStepData.image_url;

  const handleStuckFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    e.target.value = "";

    setIsProcessing(true);
    setErrorMessage("");
    setStatusMessage(`Analyzing evidence for Step ${currentStep + 1}...`);

    try {
      const stepPayload = {
        step: activeStepData.step,
        category: "component",
        action: activeStepData.action,
        caution: activeStepData.caution,
        visual_description: activeStepData.action,
      };

      const formData = new FormData();
      formData.append("file", file);
      formData.append("step", JSON.stringify(stepPayload));

      const processRes = await fetch("/api/process", {
        method: "POST",
        body: formData,
      });
      const text = await processRes.text();
      let processData: ProcessApiResponse;
      try {
        processData = (text ? JSON.parse(text) : {}) as ProcessApiResponse;
      } catch {
        throw new Error(
          "Received invalid response from process service. Check that your backend is deployed and PROCESS_API_URL is set correctly in Vercel."
        );
      }

      if (!processRes.ok) {
        throw new Error(processData.error || "Process request failed");
      }

      if (!processData.annotatedUrl) {
        throw new Error("No annotation returned for this image");
      }

      setAnnotatedByStep((prev) => ({
        ...prev,
        [currentStep]: processData.annotatedUrl as string,
      }));
      setStatusMessage(`Annotation ready for Step ${currentStep + 1}.`);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Unknown process error");
      setStatusMessage("");
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <main className="flex-1 overflow-hidden flex flex-col md:flex-row p-4 sm:p-8 gap-6">
      
      {/* Sidebar - Made slightly narrower */}
      <aside className="w-full md:w-1/4 lg:w-64 flex flex-col gap-6 shrink-0 overflow-y-auto">
        <div className="flex flex-col border-2 border-black bg-white shadow-[4px_4px_0px_rgba(0,0,0,1)]">
          <div className="px-4 pt-3 pb-2 border-b-2 border-black bg-black text-white">
            <span className="font-mono text-[10px] font-bold tracking-[0.2em] uppercase">System Context</span>
          </div>
          <div className="p-4 flex flex-col gap-4">
            <div>
              <span className="font-mono text-[9px] text-black/50 uppercase block mb-1">Identified Model</span>
              <span className="font-mono text-xs font-bold text-black">{mockDiagnosis.equipment}</span>
            </div>
            <div>
              <span className="font-mono text-[9px] text-black/50 uppercase block mb-1">Diagnosed Fault</span>
              <span className="font-mono text-xs font-bold text-brand">{mockDiagnosis.fault}</span>
            </div>
          </div>
        </div>
      </aside>

      {/* Main Carousel */}
      <section className="flex-1 flex flex-col border-2 border-black bg-white shadow-[6px_6px_0px_rgba(0,0,0,1)] relative overflow-hidden">
        <div className="px-6 py-4 border-b-2 border-black bg-studio flex items-center justify-between shrink-0">
          <span className="font-mono text-sm sm:text-base font-bold tracking-[0.2em] uppercase text-black">
            STEP {activeStepData.step.toString().padStart(2, '0')} <span className="text-black/30 mx-2">/</span> {mockSteps.length.toString().padStart(2, '0')}
          </span>
        </div>

        {/* Tightened padding and layout gap */}
        <div className="flex-1 overflow-y-auto p-5 sm:p-8 flex flex-col gap-5">
          
          {/* Constrained Image Height so it always fits */}
          <div className="w-full bg-studio border-2 border-black h-48 sm:h-64 flex items-center justify-center p-2 relative">
            <img 
              src={activeImageUrl}
              alt={`Step ${activeStepData.step}`} 
              className="w-full h-full object-contain mix-blend-multiply" 
            />
          </div>
          {statusMessage ? (
            <p className="font-mono text-[10px] uppercase tracking-widest text-black/60">
              {statusMessage}
            </p>
          ) : null}
          {errorMessage ? (
            <p className="font-mono text-[10px] uppercase tracking-widest text-brand">
              {errorMessage}
            </p>
          ) : null}
          
          {/* Shrunk the font sizes down */}
          <div className="flex flex-col gap-3 max-w-4xl">
            <p className="font-sans text-lg sm:text-2xl font-black leading-tight tracking-tight text-black">
              {activeStepData.action}
            </p>
            {activeStepData.caution !== "None" && activeStepData.caution !== "None." && (
              <div className="border-l-4 border-brand pl-4 py-1 mt-1">
                <span className="font-mono text-[9px] font-bold text-brand uppercase tracking-widest block mb-1">CAUTION</span>
                <p className="font-mono text-xs sm:text-sm font-bold text-black/80">{activeStepData.caution}</p>
              </div>
            )}
          </div>
        </div>

        <div className="shrink-0 border-t-2 border-black bg-white flex flex-col sm:flex-row">
          <div className="flex-1 flex border-b-2 sm:border-b-0 sm:border-r-2 border-black">
            <button onClick={() => setCurrentStep(prev => Math.max(0, prev - 1))} disabled={currentStep === 0} className="flex-1 py-4 px-6 font-mono text-xs font-bold tracking-[0.2em] uppercase border-r-2 border-black disabled:opacity-30 hover:bg-black hover:text-white transition-colors">&larr; Previous</button>
            <button onClick={() => setCurrentStep(prev => Math.min(mockSteps.length - 1, prev + 1))} disabled={currentStep === mockSteps.length - 1} className="flex-1 py-4 px-6 font-mono text-xs font-bold tracking-[0.2em] uppercase disabled:opacity-30 hover:bg-brand hover:text-white transition-colors">Next Step &rarr;</button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={handleStuckFile}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isProcessing}
            className="w-full sm:w-auto py-4 px-8 font-mono text-xs font-bold tracking-[0.2em] uppercase bg-black text-white hover:bg-brand transition-colors flex items-center justify-center gap-3 disabled:opacity-40"
          >
            <span>{isProcessing ? "Processing..." : "I'm Stuck"}</span>
          </button>
        </div>
      </section>
    </main>
  );
}
