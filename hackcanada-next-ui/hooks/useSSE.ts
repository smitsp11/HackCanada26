"use client";

import { useEffect, useRef, useCallback } from "react";
import { parseSSEEvent } from "@/lib/events";
import type { OperaAction } from "./useOperaReducer";

interface UseSSEOptions {
  url: string;
  enabled: boolean;
  dispatch: React.Dispatch<OperaAction>;
}

export function useSSE({ url, enabled, dispatch }: UseSSEOptions) {
  const sourceRef = useRef<EventSource | null>(null);
  const connectRef = useRef<() => void>(() => undefined);
  const retriesRef = useRef(0);
  const maxRetries = 3;

  const connect = useCallback(() => {
    if (sourceRef.current) {
      sourceRef.current.close();
    }

    const source = new EventSource(url);
    sourceRef.current = source;

    source.onmessage = (event) => {
      const parsed = parseSSEEvent(event.data);
      if (!parsed) return;

      retriesRef.current = 0;

      switch (parsed.type) {
        case "slot_processing":
          dispatch({
            type: "SLOT_PROCESSING",
            slotIndex: parsed.slotIndex,
          });
          break;
        case "slot_complete":
          dispatch({
            type: "SLOT_COMPLETE",
            slotIndex: parsed.slotIndex,
            url: parsed.url,
          });
          break;
        case "device_identified":
          dispatch({
            type: "DEVICE_IDENTIFIED",
            makeModel: parsed.makeModel,
          });
          break;
        case "manual_found":
          dispatch({
            type: "MANUAL_FOUND",
            manualId: parsed.manualId,
            title: parsed.title,
          });
          break;
        case "symptom_sections_found":
          dispatch({
            type: "SYMPTOM_SECTIONS_FOUND",
            symptom: parsed.symptom,
            sections: parsed.sections,
          });
          break;
        case "parts_check_complete":
          dispatch({
            type: "PARTS_CHECK_COMPLETE",
            parts: parsed.parts,
          });
          break;
        case "synthesis_progress":
          dispatch({
            type: "SYNTHESIS_PROGRESS",
            percent: parsed.percent,
            log: parsed.log,
          });
          break;
        case "synthesis_complete":
          dispatch({
            type: "SYNTHESIS_COMPLETE",
            steps: parsed.steps,
          });
          source.close();
          break;
        case "error":
          dispatch({ type: "ERROR", message: parsed.message });
          source.close();
          break;
      }
    };

    source.onerror = () => {
      source.close();
      if (retriesRef.current < maxRetries) {
        retriesRef.current++;
        const delay = Math.min(1000 * 2 ** retriesRef.current, 8000);
        setTimeout(() => {
          connectRef.current();
        }, delay);
      } else {
        dispatch({
          type: "ERROR",
          message: "Connection lost after maximum retries",
        });
      }
    };
  }, [url, dispatch]);

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  useEffect(() => {
    if (!enabled) return;

    connect();

    return () => {
      if (sourceRef.current) {
        sourceRef.current.close();
        sourceRef.current = null;
      }
    };
  }, [enabled, connect]);

  const disconnect = useCallback(() => {
    if (sourceRef.current) {
      sourceRef.current.close();
      sourceRef.current = null;
    }
  }, []);

  return { disconnect };
}
