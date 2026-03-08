"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import type { RepairStep } from "@/lib/events";

/** Single card height reference (px). Container stays ~1.2–1.6× this. */
const CARD_HEIGHT = 280;
/** Total stack height: bounded to 1.2–1.6 card heights. */
const STACK_HEIGHT = Math.round(CARD_HEIGHT * 1.4);
/** Slim teaser strip for collapsed cards. */
const TEASER_HEIGHT = 26;
/** Slightly larger teaser for first/last in split-peek (bounded feel). */
const TEASER_LAST_HEIGHT = 36;
/** Max visible strips below hero (keeps total height bounded). */
const MAX_VISIBLE_STRIPS = 5;
/** Hero owns most space; strips peek from below. */
const HERO_HEIGHT = STACK_HEIGHT - MAX_VISIBLE_STRIPS * TEASER_HEIGHT;
const EXPAND_DURATION = 0.3;

export type StackLayout = "top-slice" | "diagonal-fan" | "split-peek";

interface PassbookStackProps {
  steps: RepairStep[];
  activeIndex: number;
  onSelect: (index: number) => void;
  layout?: StackLayout;
}

export function PassbookStack({
  steps,
  activeIndex,
  onSelect,
  layout = "top-slice",
}: PassbookStackProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const n = steps.length;

  const getTeaserHeight = (index: number): number => {
    if (layout === "split-peek") {
      if (index === 0) return Math.round(TEASER_HEIGHT * 1.4);
      if (index === n - 1) return TEASER_LAST_HEIGHT;
      return TEASER_HEIGHT;
    }
    return TEASER_HEIGHT;
  };

  /** Strip order: cards after active first, then before (next card directly below hero). */
  const getStripIndices = (): number[] => {
    const after = Array.from({ length: n - activeIndex - 1 }, (_, j) => activeIndex + 1 + j);
    const before = Array.from({ length: activeIndex }, (_, j) => j);
    return [...after, ...before];
  };

  const getCollapsedTop = (index: number): number => {
    if (layout === "top-slice" || layout === "split-peek") {
      if (index === activeIndex) return 0;
      const stripIndices = getStripIndices();
      const pos = stripIndices.indexOf(index);
      if (pos < 0) return HERO_HEIGHT;
      let top = HERO_HEIGHT;
      for (let k = 0; k < pos; k++) {
        top += getTeaserHeight(stripIndices[k]);
      }
      return top;
    }
    // Diagonal fan: each card cascades down; keep total within STACK_HEIGHT
    const maxStep = Math.floor((STACK_HEIGHT - TEASER_HEIGHT) / (n - 1 || 1));
    const step = Math.min(14, Math.max(6, maxStep));
    return index * step;
  };

  const getCardTransform = (index: number) => {
    if (layout !== "diagonal-fan") return { x: 0, y: 0, rotate: 0 };
    // Fixed fan position: each card shifts right and rotates; active animates to 0
    const x = index * 10;
    const rotate = index * 1.8;
    return { x, y: 0, rotate };
  };

  return (
    <div
      className="relative w-full"
      style={{
        height: STACK_HEIGHT,
        minHeight: STACK_HEIGHT,
        overflow: layout === "diagonal-fan" ? "visible" : "hidden",
      }}
    >
      {steps.map((step, i) => {
        const isActive = i === activeIndex;
        const isHover = hoverIndex === i;
        const collapsedTop = getCollapsedTop(i);
        const teaserH = getTeaserHeight(i);
        const transform = getCardTransform(i);

        return (
          <motion.button
            key={step.id}
            type="button"
            onClick={() => onSelect(i)}
            onMouseEnter={() => setHoverIndex(i)}
            onMouseLeave={() => setHoverIndex(null)}
            className="absolute left-0 right-0 text-left border-2 border-black bg-white overflow-hidden cursor-pointer !rounded-[18px]"
            style={{
              boxShadow: isActive
                ? "0 8px 24px rgba(0,0,0,0.15)"
                : "0 2px 8px rgba(0,0,0,0.08)",
              transformOrigin: "top center",
            }}
            initial={false}
            animate={{
              top: isActive ? 0 : collapsedTop,
              height: isActive ? HERO_HEIGHT : teaserH,
              x: isActive ? 0 : transform.x,
              y: isActive ? 0 : transform.y,
              rotate: isActive ? 0 : transform.rotate,
              zIndex: isActive ? 20 : n - i,
              scale: isHover && !isActive ? 1.02 : 1,
              transition: {
                duration: EXPAND_DURATION,
                ease: [0.25, 0.46, 0.45, 0.94],
              },
            }}
          >
            {/* Header strip - always visible */}
            <div
              className="flex items-center justify-between px-4 border-b border-black/10"
              style={{
                minHeight: Math.min(teaserH, 52),
                backgroundColor: isActive ? "white" : "var(--color-studio)",
              }}
            >
              <span className="font-mono text-xs font-bold tracking-widest text-black/80">
                S T E P &nbsp; {String(step.id).padStart(2, "0")}
              </span>
            </div>

            {/* Expanded content - schematic (hero only) */}
            {isActive && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.2, delay: 0.1 }}
                className="p-4 flex-1 overflow-auto"
                style={{ height: HERO_HEIGHT - 52 }}
              >
                {step.schematicUrl && (
                  <img
                    src={step.schematicUrl}
                    alt={`Schematic for step ${step.id}`}
                    className="w-full h-auto object-contain"
                    style={{ maxHeight: HERO_HEIGHT - 52 - 32 }}
                  />
                )}
              </motion.div>
            )}
          </motion.button>
        );
      })}
    </div>
  );
}
