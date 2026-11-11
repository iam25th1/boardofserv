"use client";
import { useLayoutEffect, useRef } from "react";
import { animate, utils } from "animejs";
import { ease, prefersReducedMotion } from "@/lib/motion";
import { STAGE_NAMES, STAGES, stageState, type Stage } from "@/lib/journey";
import styles from "./StageTracker.module.css";

// The six stages of making an agent, across the top of the chat: the one it
// is at stands out, the ones done are ticked, the ones ahead wait in dashed
// chalk. A chalk line joins them, drawn as far as the stage it is at, and
// drawn on further when the journey moves on. Faint before the first
// message, so a first-time maker sees the way ahead.

export function StageTracker({ at, live = false, faint = false }: { at: Stage; live?: boolean; faint?: boolean }) {
  const line = useRef<HTMLSpanElement>(null);
  const was = useRef<number | null>(null);
  const index = STAGES.indexOf(at);
  // How far along the line is drawn, in percent: to the stage it is at,
  // all the way once it is live.
  const reach = (live ? 1 : index / (STAGES.length - 1)) * 100;

  useLayoutEffect(() => {
    const el = line.current;
    if (!el) return;
    const from = was.current === null ? reach : was.current;
    was.current = reach;
    if (prefersReducedMotion() || from === reach) {
      utils.set(el, { width: `${reach}%` });
      return;
    }
    animate(el, { width: { from: `${from}%`, to: `${reach}%` }, duration: 700, ease: ease.draw });
  }, [reach]);

  return (
    <nav className={styles.tracker} data-faint={faint ? "true" : undefined} aria-label="Making your agent">
      <span className={styles.line} aria-hidden="true">
        <span ref={line} className={styles.drawn} />
      </span>
      <ol className={styles.stops}>
        {STAGES.map((s, i) => {
          const state = stageState(s, at, live);
          return (
            <li key={s} data-state={state} aria-current={state === "now" ? "step" : undefined}>
              <span className={styles.dot} aria-hidden="true">
                {state === "done" ? (
                  <svg viewBox="0 0 16 16" width="14" height="14" focusable="false">
                    <path d="M3 8.5 L6.5 12 L13 4.5" />
                  </svg>
                ) : (
                  i + 1
                )}
              </span>
              <span className={styles.name}>
                {STAGE_NAMES[s]}
                <span className="visually-hidden">{state === "done" ? ", done" : state === "now" ? ", now" : ""}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
