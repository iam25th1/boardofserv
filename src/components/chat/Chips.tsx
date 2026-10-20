"use client";
import { useLayoutEffect, useRef } from "react";
import { animate, createScope, stagger } from "animejs";
import { REDUCED_MOTION, ease } from "@/lib/motion";
import styles from "./Chips.module.css";

// Suggested answers under a reply, from the mockup. Tapping one answers with
// it. The current reply format is plain streamed text with no suggested
// answers in it, so the chat does not render these yet; the /demo harness
// shows them (chips=1) for review.
export function Chips({ options, onPick }: { options: string[]; onPick: (text: string) => void }) {
  const root = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const scope = createScope({ root, mediaQueries: { reduce: REDUCED_MOTION } }).add((self) => {
      if (self?.matches.reduce) return;
      animate("button", { opacity: { from: 0, to: 1 }, translateY: { from: 6, to: 0 }, duration: 320, delay: stagger(60), ease: ease.arrive });
    });
    return () => scope.revert();
  }, []);

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
