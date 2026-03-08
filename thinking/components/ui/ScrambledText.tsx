"use client";

import React, { useEffect, useRef, useCallback, useState } from "react";

export interface ScrambledTextProps {
  radius?: number;
  duration?: number;
  speed?: number;
  scrambleChars?: string;
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}

const ScrambledText: React.FC<ScrambledTextProps> = ({
  radius = 100,
  duration = 1.2,
  speed = 0.5,
  scrambleChars = ".:",
  className = "",
  style = {},
  children,
}) => {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const charsRef = useRef<HTMLSpanElement[]>([]);
  const originalsRef = useRef<string[]>([]);
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(
    new Map()
  );

  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const timers = timersRef.current;
    setMounted(true);
    return () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
    };
  }, []);

  const scrambleChar = useCallback(
    (index: number, dist: number) => {
      const el = charsRef.current[index];
      const original = originalsRef.current[index];
      if (!el || !original || original === " ") return;

      const scrambleDuration = duration * (1 - dist / radius) * 1000;
      const intervalMs = speed * 100;
      const steps = Math.max(1, Math.floor(scrambleDuration / intervalMs));

      let step = 0;

      const prev = timersRef.current.get(index);
      if (prev) clearTimeout(prev);

      const tick = () => {
        if (step >= steps) {
          el.textContent = original;
          return;
        }
        el.textContent =
          scrambleChars[Math.floor(Math.random() * scrambleChars.length)];
        step++;
        timersRef.current.set(index, setTimeout(tick, intervalMs));
      };
      tick();
    },
    [duration, radius, scrambleChars, speed]
  );

  const handleMove = useCallback(
    (e: React.PointerEvent) => {
      charsRef.current.forEach((el, i) => {
        if (!el) return;
        const { left, top, width, height } = el.getBoundingClientRect();
        const dx = e.clientX - (left + width / 2);
        const dy = e.clientY - (top + height / 2);
        const dist = Math.hypot(dx, dy);

        if (dist < radius) {
          scrambleChar(i, dist);
        }
      });
    },
    [radius, scrambleChar]
  );

  const text =
    typeof children === "string"
      ? children
      : React.Children.toArray(children).join("");

  useEffect(() => {
    originalsRef.current = text.split("");
  }, [text]);

  if (!mounted) {
    return (
      <div
        className={`font-mono text-[clamp(14px,4vw,32px)] text-black ${className}`}
        style={style}
      >
        <p>{text}</p>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className={`font-mono text-[clamp(14px,4vw,32px)] text-black ${className}`}
      style={style}
      onPointerMove={handleMove}
    >
      <p>
        {text.split("").map((char, i) => (
          <span
            key={i}
            ref={(el) => {
              if (el) charsRef.current[i] = el;
            }}
            className="inline-block will-change-transform"
            style={char === " " ? { width: "0.3em" } : undefined}
          >
            {char}
          </span>
        ))}
      </p>
    </div>
  );
};

export default ScrambledText;
