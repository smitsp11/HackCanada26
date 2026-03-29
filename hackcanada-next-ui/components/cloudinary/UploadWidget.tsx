"use client";

import { useEffect, useRef, useState, useCallback, type ReactNode } from "react";
import { cloudName, uploadPreset } from "@/lib/cloudinary-config";

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
  defaultSource?: "local" | "camera" | "url";
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

const WIDGET_CONFIG = {
  cloudName,
  uploadPreset: uploadPreset || undefined,
  sources: ["local", "camera", "url"] as const,
  styles: {
    palette: {
      window: "#ffffff",
      windowBorder: "#09090b",
      tabIcon: "#09090b",
      menuIcons: "#09090b",
      textDark: "#09090b",
      textLight: "#ffffff",
      link: "#004DFF",
      action: "#09090b",
      inactiveTabIcon: "#a1a1aa",
      error: "#ef4444",
      inProgress: "#004DFF",
      complete: "#22c55e",
      sourceBg: "#f4f4f5",
    },
    fonts: {
      default: null,
      "sans-serif": { url: null, active: true },
    },
  },
} as const;

export function UploadWidget({
  onUploadSuccess,
  onUploadError,
  multiple = false,
  defaultSource,
  children,
}: UploadWidgetProps) {
  const widgetRef = useRef<{ open: () => void } | null>(null);
  const [isScriptReady, setIsScriptReady] = useState(false);
  const [scriptError, setScriptError] = useState(false);
  const hasConfig = cloudName.trim().length > 0;

  const onUploadSuccessRef = useRef(onUploadSuccess);
  const onUploadErrorRef = useRef(onUploadError);
  onUploadSuccessRef.current = onUploadSuccess;
  onUploadErrorRef.current = onUploadError;

  useEffect(() => {
    if (!hasConfig) return;

    let poll: ReturnType<typeof setInterval> | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let mounted = true;

    function isWidgetReady(): boolean {
      return typeof window.cloudinary?.createUploadWidget === "function";
    }

    poll = setInterval(() => {
      if (isWidgetReady()) {
        if (poll) clearInterval(poll);
        if (timeout) clearTimeout(timeout);
        if (mounted) setIsScriptReady(true);
      }
    }, 500);

    timeout = setTimeout(() => {
      if (poll) clearInterval(poll);
      if (mounted && !isWidgetReady()) {
        setScriptError(true);
      }
    }, 10000);

    if (isWidgetReady()) {
      if (poll) clearInterval(poll);
      if (timeout) clearTimeout(timeout);
      setIsScriptReady(true);
    }

    return () => {
      mounted = false;
      if (poll) clearInterval(poll);
      if (timeout) clearTimeout(timeout);
    };
  }, [hasConfig]);

  const handleOpen = useCallback(() => {
    if (!isScriptReady || typeof window.cloudinary?.createUploadWidget !== "function") return;

    if (!widgetRef.current) {
      widgetRef.current = window.cloudinary.createUploadWidget(
        {
          ...WIDGET_CONFIG,
          defaultSource,
          multiple,
        },
        (error: CloudinaryWidgetError | null, result: CloudinaryWidgetResult | null) => {
          if (error) {
            onUploadErrorRef.current?.(new Error(error.message || "Upload failed"));
            return;
          }
          if (result && result.event === "success") {
            onUploadSuccessRef.current?.(result.info);
          }
        },
      );
    }

    widgetRef.current?.open();
  }, [isScriptReady, multiple, defaultSource]);

  if (!hasConfig) {
    return (
      <div className="font-mono text-[10px] uppercase tracking-widest text-black/50">
        ERROR: CLOUDINARY CONFIG MISSING
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
    return <>{children({ open: handleOpen, isReady: isScriptReady })}</>;
  }

  return (
    <button
      type="button"
      onClick={handleOpen}
      disabled={!isScriptReady}
      className="px-6 py-3 text-xs font-bold font-mono uppercase tracking-[0.2em] bg-black text-white border-2 border-black cursor-pointer disabled:opacity-40 disabled:cursor-wait hover:bg-brand hover:border-brand transition-colors duration-200"
    >
      {isScriptReady ? "Initialize Upload" : "Loading Module"}
    </button>
  );
}
