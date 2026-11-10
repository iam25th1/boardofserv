"use client";
import { useLayoutEffect, useRef } from "react";
import { animate } from "animejs";
import { REDUCED_MOTION, ease } from "@/lib/motion";
import type { TrustDTO } from "@/lib/types";
import styles from "./Trust.module.css";

// A trust score (300 to 850): a fixed formula over what happened, never a
// model's opinion, with the factors that explain it and what it lets an
// agent pay without asking. Shown as a line on cards, with its top factors
// on an agent page, and with every factor and its trend for its maker.

const LABEL_WORDS: Record<TrustDTO["label"], string> = { new: "new", low: "low", fair: "fair", good: "good", strong: "strong", excellent: "excellent" };

export const trustLine = (t: TrustDTO) => `Trust ${t.score}, ${LABEL_WORDS[t.label]}`;

export function bandWords(t: Pick<TrustDTO, "band">): string {
  if (t.band.perPayment === 0) return "It asks before every payment.";
  return `It may pay up to ${t.band.perPayment} USDC a payment and ${t.band.perDay} USDC a day without asking.`;
}

export function TrustPanel({ t, title = "Trust", top, trend }: { t: TrustDTO; title?: string; top?: number; trend?: { day: string; score: number }[] }) {
  const factors = top ? t.factors.slice(0, top) : t.factors;
  return (
    <section className={styles.panel} aria-label={title}>
      <h2>{title}</h2>
      <p className={styles.score}>
        <strong>{t.score}</strong>
        <span>
          {LABEL_WORDS[t.label]}
          {t.isNew ? ": not enough jobs yet to earn points, only to lose them" : ""}
        </span>
      </p>
      <p className={styles.band}>{bandWords(t)}</p>
      {factors.length > 0 ? (
        <ul className={styles.factors}>
          {factors.map((f) => (
            <li key={f.key} data-sign={f.points > 0 ? "up" : "down"} data-counted={f.counted ? undefined : "false"}>
              <span className={styles.points}>{f.points > 0 ? `+${f.points}` : `${f.points}`}</span>
              <span>
                {f.words}
                {f.counted ? "" : " (counts once it isn't new)"}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.quiet}>Nothing has moved it from where every agent starts yet.</p>
      )}
      {trend && trend.length > 1 && <Trend points={trend} />}
      <p className={styles.quiet}>A fixed formula over its jobs, safety checks, Reppo&apos;s scores, reports, disputes, freezes, age, renewals and payments. Never a model&apos;s opinion.</p>
    </section>
  );
}

// The trend: a chalk line of a score a day, drawn in once (not with
// reduced motion), with each day's score on hover.
function Trend({ points }: { points: { day: string; score: number }[] }) {
  const path = useRef<SVGPathElement>(null);
  const w = 280;
  const h = 56;
  const lo = Math.min(...points.map((p) => p.score)) - 5;
  const hi = Math.max(...points.map((p) => p.score)) + 5;
  const x = (i: number) => (i / (points.length - 1)) * (w - 8) + 4;
  const y = (s: number) => h - 4 - ((s - lo) / Math.max(1, hi - lo)) * (h - 8);
  const d = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.score).toFixed(1)}`).join(" ");
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const change = last.score - first.score;
  useLayoutEffect(() => {
    const el = path.current;
    if (!el || window.matchMedia(REDUCED_MOTION).matches) return;
    const len = el.getTotalLength?.() ?? 0;
    if (!len) return;
    const a = animate(el, { strokeDashoffset: { from: len, to: 0 }, strokeDasharray: `${len} ${len}`, duration: 700, ease: ease.draw });
    return () => {
      a.revert();
    };
  }, [d]);
  return (
    <figure className={styles.trend}>
      <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`From ${first.score} on ${first.day} to ${last.score} on ${last.day}`}>
        <path ref={path} d={d} className={`${styles.line} chalky`} />
        {points.map((p, i) => (
          <circle key={p.day} cx={x(i)} cy={y(p.score)} r={6} className={styles.hit}>
            <title>{`${p.day}: ${p.score}`}</title>
          </circle>
        ))}
        <circle cx={x(points.length - 1)} cy={y(last.score)} r={3} className={styles.dot} />
      </svg>
      <figcaption className={styles.quiet}>
        {change === 0 ? "Steady" : change > 0 ? `Up ${change}` : `Down ${-change}`} since {first.day}.
      </figcaption>
    </figure>
  );
}
