"use client";

import { useState } from "react";
import { UploadWidget, type CloudinaryUploadResult } from "../cloudinary/UploadWidget";

export function InputScreen({ assets, setAssets, onExecute }: any) {
  // NEW: Isolate the typing state locally so the parent doesn't re-render on every keystroke
  const [localSymptom, setLocalSymptom] = useState("");

  const triggerExecute = () => {
    // Hand the text up to the parent ONLY when they hit submit
    onExecute(localSymptom);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { 
      e.preventDefault(); 
      triggerExecute(); 
    }
  };

  const handleUploadSuccess = (result: CloudinaryUploadResult) => {
    setAssets((prev: any) => [
      ...prev, 
      { id: result.public_id, public_id: result.public_id, secure_url: result.secure_url, figure: prev.length + 1 }
    ]);
  };

  const removeAsset = (id: string) => {
    setAssets((prev: any) => prev.filter((a: any) => a.id !== id).map((a: any, i: number) => ({ ...a, figure: i + 1 })));
  };

  const canExecute = assets.length > 0 || localSymptom.trim().length > 0;

  return (
    <main className="flex-1 overflow-y-auto px-4 sm:px-8 py-12 flex flex-col items-center">
      <div className="w-full max-w-3xl flex flex-col gap-10">
        
        {/* PROBLEM CARD */}
        <div className="flex flex-col border-2 border-black bg-white shadow-[6px_6px_0px_rgba(0,0,0,1)] hover:shadow-[6px_6px_0px_var(--color-brand)] transition-shadow duration-300">
          <div className="px-6 pt-4 pb-3 border-b-2 border-black bg-studio flex items-center justify-between">
            <span className="font-mono text-[11px] font-bold tracking-[0.2em] uppercase text-black">
              01 // Problem Definition
            </span>
          </div>
          <div className="flex flex-col p-6 gap-6">
            <textarea
              value={localSymptom} 
              onChange={(e) => setLocalSymptom(e.target.value)} 
              onKeyDown={handleKeyDown}
              placeholder="Describe the appliance fault... (Press Enter to submit)"
              className="w-full bg-studio text-black text-base leading-relaxed placeholder-black/40 outline-none resize-none border-2 border-transparent focus:border-brand p-4 font-mono transition-colors min-h-[120px]"
            />
            
            <button 
              onClick={triggerExecute} 
              disabled={!canExecute} 
              className="w-full py-4 bg-black text-white font-mono text-sm font-bold tracking-[0.2em] uppercase border-2 border-black cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed enabled:hover:bg-brand enabled:hover:border-brand transition-colors duration-200"
            >
              Execute Diagnostic
            </button>
          </div>
        </div>

        {/* VIEWS CARD */}
        <div className="flex flex-col border-2 border-black bg-white shadow-[6px_6px_0px_rgba(0,0,0,1)] hover:shadow-[6px_6px_0px_var(--color-brand)] transition-shadow duration-300">
          <div className="px-6 pt-4 pb-3 flex items-center justify-between border-b-2 border-black bg-studio">
            <span className="font-mono text-[11px] font-bold tracking-[0.2em] uppercase text-black">
              02 // Media Mounting
            </span>
            <span className="font-mono text-[10px] tracking-[0.2em] uppercase text-brand font-bold">
              {assets.length} Mounted
            </span>
          </div>
          
          <div className="p-6">
            {assets.length === 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <UploadWidget onUploadSuccess={handleUploadSuccess} multiple defaultSource="camera">
                  {({ open, isReady }) => (
                    <button type="button" onClick={open} disabled={!isReady} className="w-full min-h-[120px] border-2 border-dashed border-black/20 bg-studio flex items-center justify-center cursor-pointer hover:border-brand hover:text-brand transition-colors disabled:cursor-wait">
                      <span className="font-mono text-xs font-bold tracking-[0.2em] uppercase text-black/50">{isReady ? "[ o ] Direct Camera" : "Initializing..."}</span>
                    </button>
                  )}
                </UploadWidget>
                <UploadWidget onUploadSuccess={handleUploadSuccess} multiple defaultSource="local">
                  {({ open, isReady }) => (
                    <button type="button" onClick={open} disabled={!isReady} className="w-full min-h-[120px] border-2 border-dashed border-black/20 bg-studio flex items-center justify-center cursor-pointer hover:border-brand hover:text-brand transition-colors disabled:cursor-wait">
                      <span className="font-mono text-xs font-bold tracking-[0.2em] uppercase text-black/50">{isReady ? "[ + ] Upload File" : "Initializing..."}</span>
                    </button>
                  )}
                </UploadWidget>
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                {assets.map((asset: any) => (
                  <div key={asset.id} className="group/fig bg-studio flex flex-col border-2 border-black relative overflow-hidden">
                    <div className="relative aspect-square overflow-hidden border-b-2 border-black">
                      <img src={asset.secure_url} alt="Fig" className="w-full h-full object-cover grayscale group-hover/fig:grayscale-0 transition-all duration-500" />
                      <button type="button" onClick={() => removeAsset(asset.id)} className="absolute top-2 right-2 w-7 h-7 bg-white border-2 border-black flex items-center justify-center opacity-0 group-hover/fig:opacity-100 hover:bg-brand hover:text-white cursor-pointer transition-all">
                        <span className="font-mono font-bold text-xs leading-none mt-[-2px]">x</span>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

      </div>
    </main>
  );
}