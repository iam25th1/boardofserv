"use client";
import { useLayoutEffect, useRef } from "react";
import { createTimeline, stagger, svg, utils } from "animejs";
import { ease, prefersReducedMotion } from "@/lib/motion";
import styles from "./Landing.module.css";

// One of the front page's small chalk drawings: its strokes ([data-draw])
// draw once, in order, when it has scrolled well into view, and its notes
// ([data-note]) dust in after them; then it rests for good. With reduced
// motion (or no IntersectionObserver) it is simply there.

export function Drawing({ label, viewBox, className, children }: { label: string; viewBox: string; className?: string; children: React.ReactNode }) {
  const ref = useRef<SVGSVGElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion() || typeof IntersectionObserver === "undefined") return;
    const lines = svg.createDrawable(el.querySelectorAll<SVGGeometryElement>("[data-draw]"), 0, 0);
    const notes = el.querySelectorAll("[data-note]");
    utils.set(notes, { opacity: 0 });
    const tl = createTimeline({ autoplay: false, defaults: { ease: ease.draw } })
      .add(lines, { draw: ["0 0", "0 1"], duration: 640, delay: stagger(90) }, 0)
      .add(notes, { opacity: { from: 0, to: 1 }, translateY: { from: 4, to: 0 }, duration: 360, delay: stagger(90), ease: ease.arrive }, 380);
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        tl.play();
      },
      { threshold: 0.35 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      tl.revert();
    };
  }, []);

  return (
    <svg ref={ref} className={`${styles.drawing} ${className ?? ""} chalky`} viewBox={viewBox} {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}>
      {children}
    </svg>
  );
}

// Each section's mark on the page's spine, as on a job's timeline: a
// square for working things out, a diamond for a decision, a circle for an
// action. Drawn once, like the drawings.
export function SpineMark({ kind }: { kind: "square" | "diamond" | "circle" | "ring" }) {
  return (
    <Drawing label="" viewBox="0 0 28 28" className={styles.mark}>
      {kind === "square" ? (
        <rect data-draw x="5" y="5" width="18" height="18" rx="2" />
      ) : kind === "diamond" ? (
        <path data-draw d="M14 2 L26 14 L14 26 L2 14 Z" />
      ) : kind === "ring" ? (
        <circle data-draw cx="14" cy="14" r="11" strokeDasharray="3 3" />
      ) : (
        <circle data-draw cx="14" cy="14" r="11" />
      )}
    </Drawing>
  );
}
