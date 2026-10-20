"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { animate, createScope, createTimeline, svg, utils } from "animejs";
import { REDUCED_MOTION, animateEnter, dustIn, ease } from "@/lib/motion";
import styles from "./Thinking.module.css";

// Shown from send until the first real token. A chalk scribble draws, wipes
// and redraws on a loop while a handwritten phrase says what is going on.
// The reply replaces it the moment text arrives.

const SCRIBBLES = [
  "M4 22 C 12 4, 22 4, 26 20 S 40 38, 46 18 S 58 6, 60 22",
  "M4 28 L 14 10 L 24 30 L 34 10 L 44 30 L 54 10 L 60 24",
  "M6 20 C 6 6, 30 6, 30 20 S 54 34, 58 18 C 60 10, 50 6, 44 14",
];

const PHRASES = ["reading what you asked", "sketching the agent", "checking what it needs"];

export function Thinking() {
  const root = useRef<HTMLDivElement>(null);
  const phraseRef = useRef<HTMLSpanElement>(null);
  const [phrase, setPhrase] = useState(0);

  useLayoutEffect(() => {
    if (root.current) animateEnter(root.current);
    // Reverting a timeline can run its callbacks; nothing may advance after
    // this effect is cleaned up.
    let alive = true;
    const scope = createScope({ root, mediaQueries: { reduce: REDUCED_MOTION } }).add((self) => {
      const lines = svg.createDrawable("[data-scribble]", 0, 0);
      const advance = () => alive && setPhrase((p) => (p + 1) % PHRASES.length);

      // Reduced motion: one scribble, fully drawn and still. The words still
      // change, without any fade.
      if (self?.matches.reduce) {
        utils.set(lines[0]!, { draw: "0 1" });
        const timer = setInterval(advance, 2400);
        return () => clearInterval(timer);
      }

      // Draw a scribble, wipe it away, move to the next; a new phrase every
      // second scribble. One looping timeline drives the whole thing.
      const loop = createTimeline({ loop: true });
      let wiped = 0;
      lines.forEach((line) => {
        loop
          .add(line, { draw: ["0 0", "0 1"], duration: 700, ease: ease.scribble })
          .add(line, { draw: ["0 1", "1 1"], duration: 500, ease: "in(2)" })
          .call(() => {
            wiped += 1;
            if (wiped % 2 === 0) advance();
          });
      });
    });
    return () => {
      alive = false;
      scope.revert();
    };
  }, []);

  useEffect(() => {
    if (phrase === 0 || !phraseRef.current || window.matchMedia(REDUCED_MOTION).matches) return;
    animate(phraseRef.current, { ...dustIn, duration: 400, ease: "out(2)" });
  }, [phrase]);

  return (
    <div className={styles.think} ref={root} role="status">
      <span className="visually-hidden">Working on a reply</span>
      <svg viewBox="0 0 64 40" className="chalky" aria-hidden="true">
        {SCRIBBLES.map((d) => (
          <path key={d} d={d} data-scribble />
        ))}
      </svg>
      <span className={styles.ph} ref={phraseRef} aria-hidden="true">
        {PHRASES[phrase]}
      </span>
    </div>
  );
}
