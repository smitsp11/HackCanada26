"use client";

import { useState, useEffect, useRef, useCallback } from "react";
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
  
  // Voice Recognition & Auto-Submit State
  const [isListening, setIsListening] = useState(true);
  const [justFinishedSpeaking, setJustFinishedSpeaking] = useState(false);
  const recognitionRef = useRef<any>(null);

  // The master execute function
  const handleExecute = useCallback(() => {
    if (assets.length === 0 && !symptom.trim()) return;
    
    console.log("EXECUTE DIAGNOSTIC INIT...");
    console.log("PAYLOAD:", { assets, symptom });
    
    // TODO: Wire up your FastAPI backend call here
    
  }, [assets, symptom]);

  // Handle auto-submit after voice finishes
  useEffect(() => {
    if (justFinishedSpeaking) {
      setJustFinishedSpeaking(false); // Reset the trigger
      if (symptom.trim().length > 0 || assets.length > 0) {
        handleExecute();
      }
    }
  }, [justFinishedSpeaking, symptom, assets, handleExecute]);

  // Initialize Web Speech API
  useEffect(() => {
    if (typeof window !== "undefined") {
      const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      
      if (SpeechRecognition) {
        recognitionRef.current = new SpeechRecognition();
        recognitionRef.current.continuous = false; // Stops automatically when user pauses
        recognitionRef.current.interimResults = true; 

        recognitionRef.current.onresult = (event: any) => {
          const currentTranscript = Array.from(event.results)
            .map((res: any) => res[0].transcript)
            .join("");
          setSymptom(currentTranscript);
        };

        recognitionRef.current.onend = () => {
          setIsListening(false);
          // Trigger the auto-submit effect once the mic cuts off
          setJustFinishedSpeaking(true); 
        };

        recognitionRef.current.onerror = (event: any) => {
          console.warn("Speech error:", event.error);
          setIsListening(false);
        };

        try {
          recognitionRef.current.start();
        } catch (e) {
          console.warn("Microphone auto-start blocked by browser.");
          setIsListening(false);
        }
      }
    }

    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.abort();
      }
    };
  }, []);

  const toggleMic = () => {
    if (isListening) {
      // Manually stopping the mic will also trigger onend -> auto-submit
      recognitionRef.current?.stop();
    } else {
      setSymptom(""); 
      try {
        recognitionRef.current?.start();
        setIsListening(true);
      } catch (e) {
        console.error(e);
      }
    }
  };

  // Keyboard shortcut for power users
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // If they hit Enter (without holding Shift), prevent new line and execute
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleExecute();
    }
  };

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

  const canExecute = assets.length > 0 || symptom.trim().length > 0;

  return (
    <div className="h-screen bg-transparent text-black font-sans flex flex-col overflow-hidden">
      <header className="shrink-0 flex items-end justify-between px-8 pt-8 pb-5 border-b-2 border-black bg-white/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="flex items-baseline gap-4">
          <h1 className="text-4xl sm:text-5xl font-black tracking-tighter leading-none">
            OPERA
          </h1>
          <span className="font-mono text-xs tracking-widest text-brand font-bold uppercase hidden sm:inline-block">
            Diagnostic Engine v2.0
          </span>
        </div>
      </header>

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
              <div className="relative">
                <textarea
                  value={symptom}
                  onChange={(e) => setSymptom(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={isListening ? "Listening to your problem..." : "Describe the appliance fault... (Press Enter to submit)"}
                  className="w-full bg-studio text-black text-base leading-relaxed placeholder-black/40 outline-none resize-none border-2 border-transparent focus:border-brand p-4 pb-10 font-mono transition-colors min-h-[120px]"
                />
                
                {/* Voice Indicator / Toggle */}
                <button 
                  onClick={toggleMic}
                  className="absolute bottom-4 right-4 flex items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-widest text-black/60 hover:text-brand transition-colors cursor-pointer"
                >
                  {isListening ? (
                    <>
                      <span className="w-2.5 h-2.5 rounded-full bg-brand animate-pulse shadow-[0_0_8px_var(--color-brand)]"></span>
                      Listening (Click to Stop)
                    </>
                  ) : (
                    <>
                      <span className="w-2.5 h-2.5 rounded-full bg-black/20"></span>
                      Mic Off (Click to Talk)
                    </>
                  )}
                </button>
              </div>

              <button
                type="button"
                onClick={handleExecute}
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
                  {/* DIRECT CAMERA BUTTON */}
                  <UploadWidget onUploadSuccess={handleUploadSuccess} multiple defaultSource="camera">
                    {({ open, isReady }) => (
                      <button
                        type="button"
                        onClick={open}
                        disabled={!isReady}
                        className="w-full min-h-[120px] border-2 border-dashed border-black/20 bg-studio flex items-center justify-center cursor-pointer hover:border-brand hover:bg-brand/5 hover:text-brand transition-colors duration-200 disabled:cursor-wait group"
                      >
                        <span className="font-mono text-xs font-bold tracking-[0.2em] uppercase text-black/50 group-hover:text-brand transition-colors">
                          {isReady ? "[ o ] Direct Camera" : "Initializing..."}
                        </span>
                      </button>
                    )}
                  </UploadWidget>

                  {/* STANDARD UPLOAD BUTTON */}
                  <UploadWidget onUploadSuccess={handleUploadSuccess} multiple defaultSource="local">
                    {({ open, isReady }) => (
                      <button
                        type="button"
                        onClick={open}
                        disabled={!isReady}
                        className="w-full min-h-[120px] border-2 border-dashed border-black/20 bg-studio flex items-center justify-center cursor-pointer hover:border-brand hover:bg-brand/5 hover:text-brand transition-colors duration-200 disabled:cursor-wait group"
                      >
                        <span className="font-mono text-xs font-bold tracking-[0.2em] uppercase text-black/50 group-hover:text-brand transition-colors">
                          {isReady ? "[ + ] Upload File" : "Initializing..."}
                        </span>
                      </button>
                    )}
                  </UploadWidget>
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                    {assets.map((asset) => (
                      <div
                        key={asset.id}
                        className="group/fig bg-studio flex flex-col border-2 border-black relative overflow-hidden"
                      >
                        <div className="relative aspect-square overflow-hidden border-b-2 border-black">
                          <img
                            src={asset.secure_url}
                            alt={`Figure ${asset.figure}`}
                            className="w-full h-full object-cover grayscale group-hover/fig:grayscale-0 transition-all duration-500"
                          />
                          <div className="absolute inset-0 bg-brand/20 opacity-0 group-hover/fig:opacity-100 transition-opacity pointer-events-none" />
                          
                          <button
                            type="button"
                            onClick={() => removeAsset(asset.id)}
                            className="absolute top-2 right-2 w-7 h-7 bg-white border-2 border-black flex items-center justify-center opacity-0 group-hover/fig:opacity-100 hover:bg-brand hover:text-white cursor-pointer transition-all translate-y-2 group-hover/fig:translate-y-0"
                          >
                            <span className="font-mono font-bold text-xs leading-none mt-[-2px]">x</span>
                          </button>
                        </div>
                        <div className="px-3 py-2 flex items-center justify-between bg-white">
                          <span className="font-mono text-[10px] font-bold tracking-[0.2em] uppercase">
                            FIG. 0{asset.figure}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="mt-6 grid grid-cols-2 gap-4">
                     {/* ADD MORE - CAMERA */}
                    <UploadWidget onUploadSuccess={handleUploadSuccess} multiple defaultSource="camera">
                      {({ open, isReady }) => (
                        <button
                          type="button"
                          onClick={open}
                          disabled={!isReady}
                          className="w-full py-4 border-2 border-dashed border-black/20 bg-transparent font-mono text-[10px] font-bold tracking-[0.2em] uppercase text-black/50 cursor-pointer hover:border-brand hover:text-brand hover:bg-brand/5 transition-colors"
                        >
                          + Camera
                        </button>
                      )}
                    </UploadWidget>

                    {/* ADD MORE - UPLOAD */}
                    <UploadWidget onUploadSuccess={handleUploadSuccess} multiple defaultSource="local">
                      {({ open, isReady }) => (
                        <button
                          type="button"
                          onClick={open}
                          disabled={!isReady}
                          className="w-full py-4 border-2 border-dashed border-black/20 bg-transparent font-mono text-[10px] font-bold tracking-[0.2em] uppercase text-black/50 cursor-pointer hover:border-brand hover:text-brand hover:bg-brand/5 transition-colors"
                        >
                          + Upload
                        </button>
                      )}
                    </UploadWidget>
                  </div>
                </>
              )}
            </div>
          </div>
          
        </div>
      </main>

      <footer className="shrink-0 border-t-2 border-black px-8 py-3 flex items-center justify-between bg-white/90">
        <span className="font-mono text-[10px] font-bold tracking-[0.2em] uppercase text-black">
          SYS.STATUS: ONLINE
        </span>
        <span className="font-mono text-[10px] tracking-[0.2em] uppercase text-black/40">
          WATERLOO, ON
        </span>
      </footer>
    </div>
  );
}