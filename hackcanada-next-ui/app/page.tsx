"use client";

import { useState } from "react";
import { UploadWidget } from "./cloudinary/UploadWidget";
import type { CloudinaryUploadResult } from "./cloudinary/UploadWidget";

interface Asset {
  id: string;
  public_id: string;
  secure_url: string;
  figure: number;
}

export default function Home() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [symptom, setSymptom] = useState("");

  const handleUploadSuccess = (result: CloudinaryUploadResult) => {
    setAssets((prev) => [
      ...prev,
      {
        id: result.public_id,
        public_id: result.public_id,
        secure_url: result.secure_url,
        figure: prev.length + 1,
      },
    ]);
  };

  const removeAsset = (id: string) => {
    setAssets((prev) =>
      prev
        .filter((a) => a.id !== id)
        .map((a, i) => ({ ...a, figure: i + 1 })),
    );
  };

  const handleExecute = () => {
    if (assets.length === 0 && !symptom.trim()) return;
    console.log("EXECUTE:", { assets, symptom });
  };

  const canExecute = assets.length > 0 || symptom.trim().length > 0;

  return (
    <div className="h-screen bg-transparent text-black font-sans flex flex-col overflow-hidden">
      <header className="shrink-0 flex items-end justify-between px-8 pt-6 pb-4 border-b border-black">
        <h1 className="text-5xl sm:text-6xl font-black tracking-tighter leading-none">
          OPERA
        </h1>
      </header>

      <main className="flex-1 overflow-y-auto px-8 py-16 flex flex-col items-center">
        <div className="w-full max-w-3xl flex flex-col gap-12">
          <div className="flex flex-col border border-black bg-studio shadow-[8px_8px_0px_rgba(0,0,0,1)]">
            <div className="px-6 pt-5 pb-3 border-b border-black">
              <span className="font-mono text-[10px] tracking-[0.25em] uppercase text-black/60">
                PROBLEM
              </span>
            </div>

            <div className="flex flex-col p-6">
              <textarea
                value={symptom}
                onChange={(e) => setSymptom(e.target.value)}
                placeholder="What's wrong with your appliance"
                className="w-full bg-white text-black text-base leading-relaxed placeholder-black/40 outline-none resize-none border border-black p-4 font-sans min-h-[120px] focus:ring-2 focus:ring-black focus:ring-offset-2"
              />

              <div className="pt-6">
                <button
                  type="button"
                  onClick={handleExecute}
                  disabled={!canExecute}
                  className="w-full py-4 bg-black text-white font-mono text-xs tracking-[0.3em] uppercase border border-black cursor-pointer disabled:opacity-20 disabled:cursor-not-allowed enabled:hover:bg-white enabled:hover:text-black transition-none"
                >
                  EXECUTE DIAGNOSTIC
                </button>
              </div>
            </div>
          </div>

          <div className="flex flex-col border border-black bg-studio shadow-[8px_8px_0px_rgba(0,0,0,1)]">
            <div className="px-6 pt-5 pb-3 flex items-center justify-between border-b border-black">
              <span className="font-mono text-[10px] tracking-[0.25em] uppercase text-black/60">
                VIEWS
              </span>
              {assets.length > 0 && (
                <span className="font-mono text-[10px] tracking-[0.25em] uppercase text-black/60">
                  {assets.length} MOUNTED
                </span>
              )}
            </div>

            <div className="p-6">
              <UploadWidget onUploadSuccess={handleUploadSuccess} multiple>
                {({ open, isReady }) => (
                  <div className="flex flex-col">
                    {assets.length === 0 ? (
                      <button
                        type="button"
                        onClick={open}
                        disabled={!isReady}
                        className="w-full min-h-[160px] border border-dashed border-black/20 bg-transparent flex items-center justify-center cursor-pointer hover:border-black hover:bg-black/[0.02] transition-none disabled:cursor-wait"
                      >
                        <span className="font-mono text-[10px] tracking-[0.25em] uppercase text-black/40">
                          {isReady
                            ? "Problems you See"
                            : "INITIALIZING UPLOAD MODULE"}
                        </span>
                      </button>
                    ) : (
                      <>
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-px bg-black/10 border border-black/10">
                          {assets.map((asset) => (
                            <div
                              key={asset.id}
                              className="group/fig bg-studio flex flex-col"
                            >
                              <div className="relative aspect-square overflow-hidden border-b border-black/10">
                                <img
                                  src={asset.secure_url}
                                  alt={`Figure ${asset.figure}`}
                                  className="w-full h-full object-cover"
                                />
                                <button
                                  type="button"
                                  onClick={() => removeAsset(asset.id)}
                                  className="absolute top-2 right-2 w-5 h-5 bg-white border border-black flex items-center justify-center opacity-0 group-hover/fig:opacity-100 hover:bg-black hover:text-white cursor-pointer transition-none"
                                >
                                  <span className="text-[10px] leading-none">x</span>
                                </button>
                              </div>
                              <div className="px-3 py-2 flex items-center justify-between">
                                <span className="font-mono text-[10px] tracking-[0.2em] uppercase">
                                  FIG. {asset.figure}
                                </span>
                                <span className="font-mono text-[9px] tracking-[0.2em] uppercase text-black/40">
                                  MOUNTED
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>

                        <button
                          type="button"
                          onClick={open}
                          disabled={!isReady}
                          className="mt-6 w-full py-4 border border-dashed border-black/20 bg-transparent font-mono text-[10px] tracking-[0.25em] uppercase text-black/40 cursor-pointer hover:border-black hover:text-black transition-none"
                        >
                          + MOUNT ADDITIONAL VIEW
                        </button>
                      </>
                    )}
                  </div>
                )}
              </UploadWidget>
            </div>
          </div>
        </div>
      </main>

      <footer className="shrink-0 border-t border-black/10 px-8 py-2 flex items-center justify-between">
        <span className="font-mono text-[9px] tracking-[0.25em] uppercase text-black/25">
          APPLIANCE DIAGNOSTICS
        </span>
        <span className="font-mono text-[9px] tracking-[0.25em] uppercase text-black/25">
          2026
        </span>
      </footer>
    </div>
  );
}
