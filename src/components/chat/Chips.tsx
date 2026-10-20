"use client";
import { useLayoutEffect, useRef } from "react";
import { animate, createScope, stagger } from "animejs";
import { REDUCED_MOTION, ease } from "@/lib/motion";
import styles from "./Chips.module.css";

// Suggested answers under the latest reply, from its sketch block's choices.
// Tapping one sends it as the person's message. The /demo harness shows them
// with chips=1.
export function Chips({ options, onPick }: { options: string[]; onPick: (text: string) => void }) {
  const root = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!root.current || options.length === 0) return;
    const scope = createScope({ root, mediaQueries: { reduce: REDUCED_MOTION } }).add((self) => {
      if (self?.matches.reduce) return;
      animate("button", { opacity: { from: 0, to: 1 }, translateY: { from: 6, to: 0 }, duration: 320, delay: stagger(60), ease: ease.arrive });
    });
    return () => scope.revert();
  }, [options.length]);

  if (options.length === 0) return null;
  return (
    <div className={styles.chips} ref={root} role="group" aria-label="Suggested answers">
      {options.map((text) => (
        <button key={text} type="button" className={styles.chip} onClick={() => onPick(text)}>
          {text}
        </button>
      ))}
    </div>
  );
}
