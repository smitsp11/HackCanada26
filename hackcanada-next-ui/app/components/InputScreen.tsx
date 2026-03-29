"use client";

import { useState, useCallback, useRef } from "react";
import { uploadAsset, type UploadResult } from "@/lib/upload";

type SlotKey = "model" | "additional" | "video";

export interface IdentifiedProduct {
  product: {
    id: number;
    company: string;
    model_number: string;
    display_name: string | null;
    product_type: string | null;
  } | null;
  source: "ocr" | "gemini" | "none";
  parsedBrand?: string;
  parsedModel?: string;
}

interface SlotState {
  file: File | null;
  previewUrl: string | null;
  uploadProgress: number;
  uploadStatus: "idle" | "uploading" | "complete" | "error";
  assetId: string | null;
  error: string | null;
}

const SLOTS: { key: SlotKey; label: string; icon: string; accept: string }[] = [
  { key: "model", label: "Model Number", icon: "[ 1 ]", accept: "image/*" },
  { key: "additional", label: "Additional", icon: "[ 2 ]", accept: "image/*" },
  { key: "video", label: "Video", icon: "", accept: "video/*" },
];

const EMPTY_SLOT: SlotState = {
  file: null,
  previewUrl: null,
  uploadProgress: 0,
  uploadStatus: "idle",
  assetId: null,
  error: null,
};

export function InputScreen({ caseId, onExecute, onProductIdentified, isSubmitting = false }: {
  caseId: string | null;
  onExecute: (symptom: string) => void;
  onProductIdentified?: (result: IdentifiedProduct | null) => void;
  isSubmitting?: boolean;
}) {
  const [localSymptom, setLocalSymptom] = useState("");
  const [slots, setSlots] = useState<Record<SlotKey, SlotState>>({
    model: { ...EMPTY_SLOT },
    additional: { ...EMPTY_SLOT },
    video: { ...EMPTY_SLOT },
  });
  const [identifyStatus, setIdentifyStatus] = useState<"idle" | "loading" | "done">("idle");
  const [identified, setIdentified] = useState<IdentifiedProduct | null>(null);
  const fileInputRefs = useRef<Record<SlotKey, HTMLInputElement | null>>({
    model: null,
    additional: null,
    video: null,
  });

  const updateSlot = (key: SlotKey, patch: Partial<SlotState>) => {
    setSlots((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  };

  const handleFileSelect = useCallback(async (slotKey: SlotKey, file: File) => {
    const previewUrl = URL.createObjectURL(file);
    updateSlot(slotKey, {
      file,
      previewUrl,
      uploadStatus: "idle",
      uploadProgress: 0,
      error: null,
      assetId: null,
    });

    if (!caseId) return;

    updateSlot(slotKey, { uploadStatus: "uploading" });

    try {
      const result: UploadResult = await uploadAsset(
        caseId,
        file,
        slotKey,
        (percent) => updateSlot(slotKey, { uploadProgress: percent }),
      );

      updateSlot(slotKey, {
        uploadStatus: "complete",
        assetId: result.assetId,
        uploadProgress: 100,
      });

      if (slotKey === "model") {
        runIdentification(previewUrl, caseId);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Upload failed";
      updateSlot(slotKey, { uploadStatus: "error", error: message });
    }
  }, [caseId]);

  const runIdentification = (imageUrl: string, currentCaseId: string) => {
    setIdentifyStatus("loading");
    setIdentified(null);

    fetch("/api/identify-product", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageUrl, case_id: currentCaseId }),
    })
      .then((res) => res.json())
      .then((data: IdentifiedProduct) => {
        setIdentified(data);
        setIdentifyStatus("done");
        onProductIdentified?.(data);
      })
      .catch(() => {
        setIdentifyStatus("done");
        onProductIdentified?.(null);
      });
  };

  const removeSlot = (slotKey: SlotKey) => {
    const slot = slots[slotKey];
    if (slot.previewUrl) URL.revokeObjectURL(slot.previewUrl);
    setSlots((prev) => ({ ...prev, [slotKey]: { ...EMPTY_SLOT } }));
    if (slotKey === "model") {
      setIdentified(null);
      setIdentifyStatus("idle");
      onProductIdentified?.(null);
    }
  };

  const triggerExecute = () => onExecute(localSymptom);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      triggerExecute();
    }
  };

  const filledCount = Object.values(slots).filter((s) => s.file !== null).length;
  const allUploaded = Object.values(slots).every(
    (s) => s.file === null || s.uploadStatus === "complete",
  );
  const canExecute = filledCount === 3 && localSymptom.trim().length > 0 && allUploaded && !isSubmitting;

  return (
    <main className="flex-1 overflow-y-auto px-4 sm:px-8 py-6 flex flex-col items-center">
      <div className="w-full max-w-4xl flex flex-col gap-8">

        {/* MEDIA MOUNTING CARD */}
        <div className="flex flex-col border-2 border-black bg-white shadow-[6px_6px_0px_rgba(0,0,0,1)] hover:shadow-[6px_6px_0px_var(--color-brand)] transition-shadow duration-300">
          <div className="px-7 pt-4 pb-3 flex items-center justify-between border-b-2 border-black bg-studio">
            <span className="font-mono text-[11px] font-bold tracking-[0.2em] uppercase text-black">
              // Media Mounting
            </span>
            <span className="font-mono text-[10px] tracking-[0.2em] uppercase text-brand font-bold">
              {filledCount} Mounted
            </span>
          </div>

          <div className="p-5">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {SLOTS.map((slot) => {
                const slotState = slots[slot.key];
                return (
                  <div key={slot.key} className="flex flex-col gap-1.5">
                    <input
                      ref={(el) => { fileInputRefs.current[slot.key] = el; }}
                      type="file"
                      accept={slot.accept}
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) handleFileSelect(slot.key, file);
                        e.target.value = "";
                      }}
                    />

                    {slotState.file ? (
                      <div className="group/fig relative border-2 border-black bg-studio aspect-square overflow-hidden">
                        {slot.key === "video" ? (
                          <video src={slotState.previewUrl!} className="w-full h-full object-cover" muted />
                        ) : (
                          <img src={slotState.previewUrl!} alt={slot.label} className="w-full h-full object-cover grayscale group-hover/fig:grayscale-0 transition-all duration-500" />
                        )}

                        {/* Upload progress overlay */}
                        {slotState.uploadStatus === "uploading" && (
                          <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                            <div className="w-3/4">
                              <div className="h-1.5 bg-white/30 overflow-hidden">
                                <div
                                  className="h-full bg-white transition-all duration-300"
                                  style={{ width: `${slotState.uploadProgress}%` }}
                                />
                              </div>
                              <span className="block text-center font-mono text-[10px] text-white mt-1">
                                {slotState.uploadProgress}%
                              </span>
                            </div>
                          </div>
                        )}

                        {slotState.uploadStatus === "error" && (
                          <div className="absolute inset-0 bg-red-900/60 flex items-center justify-center p-2">
                            <span className="font-mono text-[10px] text-white text-center">
                              {slotState.error || "Upload failed"}
                            </span>
                          </div>
                        )}

                        {slotState.uploadStatus === "complete" && (
                          <div className="absolute top-1.5 left-1.5 w-5 h-5 bg-brand border border-black flex items-center justify-center">
                            <span className="text-white text-[10px] font-bold">&#10003;</span>
                          </div>
                        )}

                        <button type="button" onClick={() => removeSlot(slot.key)} className="absolute top-1.5 right-1.5 w-7 h-7 bg-white border-2 border-black flex items-center justify-center opacity-0 group-hover/fig:opacity-100 hover:bg-brand hover:text-white cursor-pointer transition-all">
                          <span className="font-mono font-bold text-xs leading-none">x</span>
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => fileInputRefs.current[slot.key]?.click()}
                        disabled={!caseId}
                        className="aspect-square border-2 border-dashed border-black/20 bg-studio flex flex-col items-center justify-center cursor-pointer hover:border-brand hover:text-brand transition-colors disabled:cursor-wait disabled:opacity-50"
                      >
                        {slot.key === "video" ? (
                          <svg className="w-6 h-6 text-black/30" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}>
                            <path strokeLinecap="square" strokeLinejoin="miter" d="M12 16V4m0 0l-4 4m4-4l4 4M4 18h16" />
                          </svg>
                        ) : (
                          <span className="font-mono text-base font-bold text-black/30">{slot.icon}</span>
                        )}
                      </button>
                    )}
                    <span className="font-mono text-[10px] font-bold tracking-[0.15em] uppercase text-black/40 text-center">
                      {slot.label}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Product identification result */}
          {identifyStatus === "loading" && (
            <div className="px-5 pb-4">
              <div className="flex items-center gap-2 py-2 px-3 bg-studio border border-black/10">
                <span className="font-mono text-[10px] tracking-[0.15em] uppercase text-black/50 animate-pulse">
                  Identifying product...
                </span>
              </div>
            </div>
          )}
          {identifyStatus === "done" && identified && (
            <div className="px-5 pb-4">
              <div className="py-2 px-3 bg-studio border border-black/10">
                {identified.product ? (
                  <div className="flex flex-col gap-0.5">
                    <span className="font-mono text-[10px] tracking-[0.15em] uppercase text-brand font-bold">
                      Match: {identified.source.toUpperCase()}
                    </span>
                    <span className="font-mono text-xs text-black font-bold">
                      {identified.product.company} &mdash; {identified.product.display_name || identified.product.model_number}
                    </span>
                    <span className="font-mono text-[10px] text-black/50">
                      Model: {identified.product.model_number} | Type: {identified.product.product_type || "N/A"}
                    </span>
                  </div>
                ) : identified.parsedBrand || identified.parsedModel ? (
                  <div className="flex flex-col gap-0.5">
                    <span className="font-mono text-[10px] tracking-[0.15em] uppercase text-black/50 font-bold">
                      No DB match &mdash; detected:
                    </span>
                    <span className="font-mono text-xs text-black">
                      {[identified.parsedBrand, identified.parsedModel].filter(Boolean).join(" / ")}
                    </span>
                  </div>
                ) : (
                  <span className="font-mono text-[10px] tracking-[0.15em] uppercase text-black/40">
                    Could not identify product
                  </span>
                )}
              </div>
            </div>
          )}
        </div>

        {/* PROBLEM DEFINITION CARD */}
        <div className="flex flex-col border-2 border-black bg-white shadow-[6px_6px_0px_rgba(0,0,0,1)] hover:shadow-[6px_6px_0px_var(--color-brand)] transition-shadow duration-300">
          <div className="px-7 pt-4 pb-3 border-b-2 border-black bg-studio flex items-center justify-between">
            <span className="font-mono text-[11px] font-bold tracking-[0.2em] uppercase text-black">
              // Problem Definition
            </span>
          </div>
          <div className="flex flex-col p-6 gap-5">
            <textarea
              value={localSymptom}
              onChange={(e) => setLocalSymptom(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Describe the appliance fault... (Press Enter to submit)"
              className="w-full bg-studio text-black text-base leading-relaxed placeholder-black/40 outline-none resize-none border-2 border-transparent focus:border-brand p-5 font-mono transition-colors min-h-[112px]"
            />

            <div className="flex flex-col gap-2">
              <button
                onClick={triggerExecute}
                disabled={!canExecute}
                className="w-full py-4 bg-black text-white font-mono text-sm font-bold tracking-[0.2em] uppercase border-2 border-black cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed enabled:hover:bg-brand enabled:hover:border-brand transition-colors duration-200"
              >
                {isSubmitting ? "Creating Case..." : "Execute Diagnostic"}
              </button>
            </div>
          </div>
        </div>

      </div>
    </main>
  );
}
