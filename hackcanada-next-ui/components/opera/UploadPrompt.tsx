"use client";

import { useCallback, useRef, useState } from "react";
import { motion } from "framer-motion";

interface UploadPromptProps {
  onUpload: (file: File) => void;
}

export default function UploadPrompt({ onUpload }: UploadPromptProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleFile = useCallback(
    (file: File) => {
      if (
        file.type.startsWith("video/") ||
        file.type.startsWith("image/")
      ) {
        onUpload(file);
      }
    },
    [onUpload]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile]
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleFile(file);
    },
    [handleFile]
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      transition={{ duration: 0.3 }}
      className="flex min-h-screen flex-col items-center justify-center px-8"
    >
      <div className="mb-12">
        <h1 className="text-center font-sans text-6xl font-black tracking-tighter text-black">
          Opera AI
        </h1>
        <p className="opera-label mt-4 text-center text-black/60">
          D I A G N O S T I C &nbsp; I N T E R F A C E
        </p>
      </div>

      <div
        className={`opera-border relative flex h-72 w-full max-w-xl cursor-pointer flex-col items-center justify-center transition-colors ${
          isDragging ? "bg-gray-100" : "bg-white"
        }`}
        style={{ borderStyle: "dashed", borderWidth: "2px" }}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
      >
        <span className="opera-label text-lg text-black/80">
          D R O P &nbsp; M E D I A
        </span>
        <span className="mt-4 font-mono text-xs text-black/40">
          VIDEO OR IMAGE OF APPLIANCE
        </span>
        <input
          ref={inputRef}
          type="file"
          accept="video/*,image/*"
          className="hidden"
          onChange={handleChange}
        />
      </div>

      <p className="opera-label mt-8 text-black/30">
        V 1 . 0 . 0
      </p>
    </motion.div>
  );
}
