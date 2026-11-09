"use client";
import { useLayoutEffect, useRef, useState } from "react";
import { createScope, createTimeline, stagger, svg } from "animejs";
import { formatAmount } from "@/lib/money";
import { REDUCED_MOTION, ease } from "@/lib/motion";
import styles from "./MakerDashboard.module.css";

// What an agent earned its maker each week, as chalk columns on one
// baseline: thin (at most 24px), rounded at the top, square at the
// bottom, the latest week's amount written on its cap. Each week (its
// whole band) is a hover and focus target with its amount; a table carries
// the same numbers for screen readers. The baseline is drawn and the
// columns rise once, when it first shows.

const short = (iso: string) => new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(iso));

export function EarningsChart({ weeks, decimals }: { weeks: { week: string; amount: string }[]; decimals: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState<number | null>(null);
  const amounts = weeks.map((w) => BigInt(w.amount));
  const max = amounts.reduce((m, a) => (a > m ? a : m), 0n);
  const share = (a: bigint) => (max === 0n ? 0 : Number((a * 10_000n) / max) / 100);
  const usdc = (a: bigint) => `${formatAmount(a, decimals)} USDC`;
  const last = weeks.length - 1;

  useLayoutEffect(() => {
    if (!ref.current) return;
    const scope = createScope({ root: ref, mediaQueries: { reduce: REDUCED_MOTION } }).add((self) => {
      if (self?.matches.reduce) return;
      createTimeline({ defaults: { ease: ease.draw } })
        .add(svg.createDrawable("[data-base]", 0, 0), { draw: ["0 0", "0 1"], duration: 420 }, 0)
        .add("[data-col]", { scaleY: { from: 0, to: 1 }, duration: 520, delay: stagger(50) }, 160)
        .add("[data-cap]", { opacity: { from: 0, to: 1 }, duration: 240 }, 640);
    });
    return () => scope.revert();
  }, []);

  return (
    <div className={styles.chart} ref={ref}>
      <div className={styles.plot}>
        {weeks.map((w, i) => (
          <button
            key={w.week}
            type="button"
            className={styles.band}
            aria-label={`Week of ${short(w.week)}: ${usdc(amounts[i]!)}`}
            data-on={shown === i ? "true" : undefined}
            onPointerEnter={() => setShown(i)}
            onPointerLeave={() => setShown((s) => (s === i ? null : s))}
            onFocus={() => setShown(i)}
            onBlur={() => setShown((s) => (s === i ? null : s))}
          >
            {i === last && amounts[i]! > 0n && (
              <span data-cap className={styles.cap} aria-hidden="true">
                {formatAmount(amounts[i]!, decimals)}
              </span>
            )}
            {amounts[i]! > 0n && <span data-col className={styles.col} style={{ height: `${share(amounts[i]!)}%` }} aria-hidden="true" />}
            {shown === i && (
              <span className={styles.tip} aria-hidden="true">
                <strong>{usdc(amounts[i]!)}</strong>
                <span>week of {short(w.week)}</span>
              </span>
            )}
          </button>
        ))}
        <svg className={`${styles.base} chalky`} viewBox="0 0 100 2" preserveAspectRatio="none" aria-hidden="true" focusable="false">
          <path data-base d="M0 1 L100 1" />
        </svg>
      </div>
      <div className={styles.ticks} aria-hidden="true">
        {weeks.map((w) => (
          <span key={w.week}>{short(w.week)}</span>
        ))}
      </div>
      <table className="visually-hidden">
        <caption>Earned each week</caption>
        <thead>
          <tr>
            <th scope="col">Week of</th>
            <th scope="col">Earned</th>
          </tr>
        </thead>
        <tbody>
          {weeks.map((w, i) => (
            <tr key={w.week}>
              <td>{short(w.week)}</td>
              <td>{usdc(amounts[i]!)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
