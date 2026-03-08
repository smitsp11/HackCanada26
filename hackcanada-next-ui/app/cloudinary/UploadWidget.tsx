"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cloudName, uploadPreset } from "./config";

export interface CloudinaryUploadResult {
  public_id: string;
  secure_url: string;
  url: string;
  width: number;
  height: number;
  format: string;
  resource_type: string;
  bytes: number;
  created_at: string;
}

interface UploadWidgetProps {
  onUploadSuccess?: (result: CloudinaryUploadResult) => void;
  onUploadError?: (error: Error) => void;
  multiple?: boolean;
  children?: (props: { open: () => void; isReady: boolean }) => ReactNode;
}

interface CloudinaryWidgetResult {
  event: string;
  info: CloudinaryUploadResult;
}

interface CloudinaryWidgetError {
  message?: string;
}

declare global {
  interface Window {
    cloudinary?: {
      createUploadWidget: (
        config: Record<string, unknown>,
        callback: (
          error: CloudinaryWidgetError | null,
          result: CloudinaryWidgetResult | null,
        ) => void,
      ) => { open: () => void };
    };
  }
}

export function UploadWidget({
  onUploadSuccess,
  onUploadError,
  multiple = false,
  children,
}: UploadWidgetProps) {
  const widgetRef = useRef<{ open: () => void } | null>(null);
  const [openWidget, setOpenWidget] = useState<(() => void) | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [scriptError, setScriptError] = useState(false);
  const hasConfig = cloudName.trim().length > 0;

  useEffect(() => {
    if (!hasConfig) return;

    let poll: ReturnType<typeof setInterval> | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let mounted = true;

    function initializeWidget() {
      if (!mounted || typeof window.cloudinary?.createUploadWidget !== "function")
        return;

      widgetRef.current = window.cloudinary.createUploadWidget(
        {
          cloudName,
          uploadPreset: uploadPreset || undefined,
          sources: ["local", "camera", "url"],
          multiple,
        },
        (error: CloudinaryWidgetError | null, result: CloudinaryWidgetResult | null) => {
          if (error) {
            onUploadError?.(new Error(error.message || "Upload failed"));
            return;
          }
          if (result && result.event === "success") {
            onUploadSuccess?.(result.info);
          }
        },
      );

      setOpenWidget(() => () => {
        widgetRef.current?.open();
      });
      setIsReady(true);
    }

    function isWidgetReady(): boolean {
      return typeof window.cloudinary?.createUploadWidget === "function";
    }

    poll = setInterval(() => {
      if (isWidgetReady()) {
        if (poll) clearInterval(poll);
        if (timeout) clearTimeout(timeout);
        initializeWidget();
      }
    }, 100);

    timeout = setTimeout(() => {
      if (poll) clearInterval(poll);
      if (mounted && !isWidgetReady()) {
        setScriptError(true);
      }
    }, 10000);

    if (isWidgetReady()) {
      if (poll) clearInterval(poll);
      if (timeout) clearTimeout(timeout);
      initializeWidget();
    }

    return () => {
      mounted = false;
      if (poll) clearInterval(poll);
      if (timeout) clearTimeout(timeout);
    };
  }, [hasConfig, multiple, onUploadError, onUploadSuccess]);

  const handleOpen = () => {
    if (openWidget) {
      openWidget();
    }
  };

  if (!hasConfig) {
    return (
      <div className="font-mono text-[10px] uppercase tracking-widest text-black/50">
        ERROR: CLOUDINARY CONFIG MISSING IN app/cloudinary/config.ts
      </div>
    );
  }

  if (scriptError) {
    return (
      <div className="font-mono text-[10px] uppercase tracking-widest text-black/50">
        ERROR: UPLOAD MODULE UNAVAILABLE
      </div>
    );
  }

  if (children) {
    return <>{children({ open: handleOpen, isReady })}</>;
  }

  return (
    <button
      type="button"
      onClick={handleOpen}
      disabled={!isReady}
      className="px-5 py-2.5 text-xs font-mono uppercase tracking-widest bg-black text-white border border-black cursor-pointer disabled:opacity-40 disabled:cursor-wait hover:bg-white hover:text-black transition-none"
    >
      {isReady ? "UPLOAD" : "LOADING"}
    </button>
  );
}
