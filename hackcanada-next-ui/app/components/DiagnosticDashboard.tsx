"use client";

import { useState } from "react";
import { UploadWidget, type CloudinaryUploadResult } from "../cloudinary/UploadWidget";

export function DiagnosticDashboard({ assets, mockDiagnosis, mockSteps }: any) {
  const [currentStep, setCurrentStep] = useState(0);
  const activeStepData = mockSteps[currentStep];

  const handleStuckUpload = (result: CloudinaryUploadResult) => {
    alert(`Evidence mounted for Step ${currentStep + 1}. Analyzing workspace...`);
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
              src={activeStepData.image_url} 
              alt={`Step ${activeStepData.step}`} 
              className="w-full h-full object-contain mix-blend-multiply" 
            />
          </div>
          
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
          <UploadWidget onUploadSuccess={handleStuckUpload} defaultSource="camera">
            {({ open, isReady }) => (
              <button onClick={open} disabled={!isReady} className="w-full sm:w-auto py-4 px-8 font-mono text-xs font-bold tracking-[0.2em] uppercase bg-black text-white hover:bg-brand transition-colors flex items-center justify-center gap-3">
                <span>I'm Stuck</span>
              </button>
            )}
          </UploadWidget>
        </div>
      </section>
    </main>
  );
}