"use client";
import { useLayoutEffect, useRef } from "react";
import { createScope, createTimeline, stagger, svg, utils } from "animejs";
import { REDUCED_MOTION, ease } from "@/lib/motion";
import styles from "./Landing.module.css";

// The front page's one orchestrated moment: a little agent drawn in chalk,
// as an agent on boardofserv really runs. A clock wakes it; a square reads
// your sheet, a diamond decides, a ring with a question asks you before it
// spends over your limit, a circle writes the order. Its connections hang
// below on dashed lines. The strokes draw in order, the handwritten notes
// dust in beside them, then one chalk dot runs the job once, waits a beat
// at the question, and the last circle ticks. With reduced motion the
// drawing is simply there. On a phone the same run stands upright, its
// notes beside each mark, so they stay readable.

export function HeroMachine({ variant }: { variant: "wide" | "tall" }) {
  const root = useRef<SVGSVGElement>(null);

  useLayoutEffect(() => {
    const scope = createScope({ root, mediaQueries: { reduce: REDUCED_MOTION } }).add((self) => {
      if (self?.matches.reduce) return;
      const draw = (sel: string) => svg.createDrawable(sel, 0, 0);
      const spine = draw("[data-spine]");
      const marks = draw("[data-mark]");
      const hangs = root.current?.querySelector("[data-hang]") ? draw("[data-hang]") : [];
      const things = root.current?.querySelector("[data-thing]") ? draw("[data-thing]") : [];
      utils.set(["[data-note]", "[data-tick]"], { opacity: 0 });
      const toQuestion = svg.createMotionPath("[data-route-a]");
      const toEnd = svg.createMotionPath("[data-route-b]");
      createTimeline({ defaults: { ease: ease.draw } })
        .add(marks, { draw: ["0 0", "0 1"], duration: 520, delay: stagger(140) }, 0)
        .add(spine, { draw: ["0 0", "0 1"], duration: 900 }, 120)
        .add("[data-note]", { opacity: { from: 0, to: 1 }, translateY: { from: 4, to: 0 }, duration: 380, delay: stagger(110), ease: ease.arrive }, 520)
        .add(hangs, { draw: ["0 0", "0 1"], duration: 420, delay: stagger(120) }, 900)
        .add(things, { draw: ["0 0", "0 1"], duration: 560, delay: stagger(60) }, 1040)
        // The job runs once: to the question, a beat, then on to the end.
        .add("[data-dot]", { opacity: { from: 0, to: 1 }, duration: 160 }, 1700)
        .add("[data-dot]", { ...toQuestion, duration: 1300, ease: "inOut(2)" }, 1700)
        .add("[data-dot]", { ...toEnd, duration: 600, ease: "inOut(2)" }, 3400)
        .add("[data-dot]", { opacity: { from: 1, to: 0 }, duration: 240 }, 4000)
        .add("[data-tick]", { opacity: { from: 0, to: 1 }, duration: 260 }, 3950);
    });
    return () => scope.revert();
  }, []);

  const label =
    "An agent drawn in chalk: every morning it reads your sheet, decides whether anything is low, asks you in Telegram before an order over your limit, then writes the order.";
  if (variant === "tall") {
    return (
      <svg ref={root} className={`${styles.machine} ${styles.machineTall} chalky`} viewBox="0 0 320 440" role="img" aria-label={label}>
        <path data-spine className={styles.stroke} d="M44 66 V114 M44 158 V196 M44 252 V286 M44 342 V374" />
        <path data-route-a className={styles.route} d="M44 40 V314" />
        <path data-route-b className={styles.route} d="M44 314 V400" />
        <circle data-mark className={styles.stroke} cx="44" cy="40" r="26" />
        <path data-mark className={styles.stroke} d="M44 24 V40 L55 48" />
        <rect data-mark className={styles.stroke} x="22" y="114" width="44" height="44" rx="4" />
        <path data-mark className={styles.stroke} d="M44 196 L72 224 L44 252 L16 224 Z" />
        <circle data-mark className={styles.dashed} cx="44" cy="314" r="28" />
        <path data-mark className={styles.stroke} d="M36 306 C36 296 52 296 52 305 C52 312 44 312 44 319 M44 327 V328" />
        <circle data-mark className={styles.stroke} cx="44" cy="400" r="26" />
        <path data-tick className={styles.tick} d="M32 401 L41 410 L57 390" />
        <text data-note className={styles.hand} x="92" y="47">
          every morning
        </text>
        <text data-note className={styles.hand} x="92" y="143">
          reads your sheet
        </text>
        <text data-note className={styles.hand} x="92" y="231">
          anything low?
        </text>
        <text data-note className={styles.hand} x="92" y="310">
          asks you first,
        </text>
        <text data-note className={styles.hand} x="92" y="334">
          in Telegram
        </text>
        <text data-note className={styles.hand} x="92" y="407">
          writes the order
        </text>
        <circle data-dot className={styles.dot} cx="0" cy="0" r="5" />
      </svg>
    );
  }
  return (
    <svg ref={root} className={`${styles.machine} ${styles.machineWide} chalky`} viewBox="0 0 640 400" role="img" aria-label={`${label} It reaches your Google Sheet, the web and your Telegram.`}>
      {/* The run, left to right. */}
      <path data-spine className={styles.stroke} d="M86 130 H164 M210 130 H272 M328 130 H392 M448 130 H514" />
      <path data-route-a className={styles.route} d="M60 130 H420" />
      <path data-route-b className={styles.route} d="M420 130 H540" />
      {/* The clock that wakes it. */}
      <circle data-mark className={styles.stroke} cx="60" cy="130" r="26" />
      <path data-mark className={styles.stroke} d="M60 114 V130 L71 138" />
      {/* Reads (code): a square. */}
      <rect data-mark className={styles.stroke} x="166" y="108" width="44" height="44" rx="4" />
      {/* Decides: a diamond. */}
      <path data-mark className={styles.stroke} d="M300 102 L328 130 L300 158 L272 130 Z" />
      {/* Asks first: a dashed ring with a question in it. */}
      <circle data-mark className={styles.dashed} cx="420" cy="130" r="28" />
      <path data-mark className={styles.stroke} d="M412 122 C412 112 428 112 428 121 C428 128 420 128 420 135 M420 143 V144" />
      {/* Acts: a circle. */}
      <circle data-mark className={styles.stroke} cx="540" cy="130" r="26" />
      <path data-tick className={styles.tick} d="M528 131 L537 140 L553 120" />

      {/* Its connections, hanging below. */}
      <path data-hang className={styles.dashed} d="M188 152 V258 M300 158 C300 210 300 210 300 258 M420 158 V258" />
      {/* A sheet. */}
      <rect data-thing className={styles.stroke} x="152" y="262" width="72" height="56" rx="4" />
      <path data-thing className={styles.thin} d="M152 280 H224 M152 299 H224 M176 262 V318 M200 262 V318" />
      {/* The web: a globe. */}
      <circle data-thing className={styles.stroke} cx="300" cy="290" r="28" />
      <path data-thing className={styles.thin} d="M272 290 H328 M300 262 C286 276 286 304 300 318 C314 304 314 276 300 262" />
      {/* Telegram: a speech bubble. */}
      <path data-thing className={styles.stroke} d="M388 266 H452 Q460 266 460 274 V300 Q460 308 452 308 H416 L402 320 V308 H388 Q380 308 380 300 V274 Q380 266 388 266 Z" />
      <path data-thing className={styles.thin} d="M396 280 H444 M396 292 H430" />

      {/* The handwritten notes, two short lines each. */}
      {(
        [
          [60, "every", "morning"],
          [188, "reads", "your sheet"],
          [300, "anything", "low?"],
          [420, "asks you", "first"],
          [540, "writes", "the order"],
        ] as const
      ).map(([x, a, b]) => (
        <text key={x} data-note className={styles.hand} x={x} y="62" textAnchor="middle">
          <tspan x={x}>{a}</tspan>
          <tspan x={x} dy="22">
            {b}
          </tspan>
        </text>
      ))}
      <text data-note className={styles.handSm} x="188" y="346" textAnchor="middle">
        your sheet
      </text>
      <text data-note className={styles.handSm} x="300" y="346" textAnchor="middle">
        the web
      </text>
      <text data-note className={styles.handSm} x="420" y="346" textAnchor="middle">
        your Telegram
      </text>

      {/* The job, as one dot that runs it once (hidden when still). */}
      <circle data-dot className={styles.dot} cx="0" cy="0" r="5" />
    </svg>
  );
}
