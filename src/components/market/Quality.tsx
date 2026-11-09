"use client";
import { useLayoutEffect, useRef } from "react";
import { animate, stagger } from "animejs";
import { REDUCED_MOTION, ease } from "@/lib/motion";
import type { QualityDTO, ScoredJobDTO } from "@/lib/types";
import styles from "./Quality.module.css";

// An agent's quality, from Reppo: its listed version's rolling score from a
// sample of finished jobs, shown once enough were reviewed, with how many
// were and how Reppo routed them; the version before as history. Reppo
// scores a summary of each job with no renter data in it.

export const ROUTE_WORDS = { ship: "good to use", review: "needs a look", block: "advised against" } as const;

// One line, for a card or a list of facts.
export function qualityLine(q: QualityDTO): string {
  if (q.score === null) return q.reviewed > 0 ? `not enough reviewed jobs yet (${q.reviewed} of ${q.minimum})` : "not enough reviewed jobs yet";
  return `${q.score} out of 100, from ${q.reviewed} reviewed ${q.reviewed === 1 ? "job" : "jobs"}`;
}

// The whole of it: the score, the routes as chalk bars (drawn in once, not
// with reduced motion), and the earlier version's score.
export function QualityPanel({ q, title = "Quality" }: { q: QualityDTO; title?: string }) {
  const root = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el || q.score === null || window.matchMedia(REDUCED_MOTION).matches) return;
    const a = animate(el.querySelectorAll("[data-fill]"), { scaleX: { from: 0, to: 1 }, duration: 600, delay: stagger(80), ease: ease.draw });
    return () => {
      a.revert();
    };
  }, [q.score, q.ship, q.review, q.block]);
  return (
    <section ref={root} className={styles.panel} aria-labelledby="quality-h">
      <h2 id="quality-h">{title}</h2>
      {q.score === null ? (
        <p className={styles.pending}>{qualityLine(q)}</p>
      ) : (
        <>
          <p className={styles.score}>
            <strong>{q.score}</strong>
            <span>out of 100, from {q.reviewed} reviewed {q.reviewed === 1 ? "job" : "jobs"}</span>
          </p>
          <ul className={styles.routes}>
            {(["ship", "review", "block"] as const).map((r) => (
              <li key={r}>
                <span>{ROUTE_WORDS[r]}</span>
                <span className={styles.bar} aria-hidden="true">
                  <span data-fill style={{ width: `${q[r]}%` }} />
                </span>
                <span>{q[r]}%</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {q.previous && (
        <p className={styles.history}>
          Version {q.previous.version} scored {q.previous.score} from {q.previous.reviewed} reviewed jobs.
        </p>
      )}
      <p className={styles.note}>Reppo&apos;s evaluators score a sample of finished jobs from a summary with no renter data in it. A new version starts fresh.</p>
    </section>
  );
}

// The maker's scored jobs, newest first, with nothing of the renter's.
export function ScoredJobs({ jobs }: { jobs: ScoredJobDTO[] }) {
  return (
    <section className={styles.panel} aria-labelledby="scored-h">
      <h2 id="scored-h">Jobs Reppo scored</h2>
      {jobs.length === 0 ? (
        <p className={styles.pending}>None yet: Reppo scores the first few jobs of each new version, then one in every few.</p>
      ) : (
        <ol className={styles.jobs}>
          {jobs.map((j) => (
            <li key={j.id} data-route={j.route ?? undefined}>
              <div className={styles.jobHead}>
                <strong>{j.score ?? "?"}</strong>
                <span className={styles.chip}>{j.route ? ROUTE_WORDS[j.route] : "no route"}</span>
                <span className={styles.meta}>
                  version {j.version}
                  {j.confidence ? `, ${j.confidence} confidence` : ""}
                </span>
                <time dateTime={j.at} className={styles.meta}>
                  {new Date(j.at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                </time>
              </div>
              {j.reason && <p>{j.reason}</p>}
              {Object.keys(j.rubric).length > 0 && (
                <ul className={styles.rubric} aria-label="Rubric scores">
                  {Object.entries(j.rubric).map(([k, v]) => (
                    <li key={k}>
                      {k} {v}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
