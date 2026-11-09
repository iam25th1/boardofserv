"use client";
import { useLayoutEffect, useRef } from "react";
import { animate } from "animejs";
import { REDUCED_MOTION, ease } from "@/lib/motion";
import type { ReppoAdminDTO } from "@/lib/types";
import styles from "./ReppoCredits.module.css";

// Reppo's quality checks for the admin: today's credits against the day's
// budget (a chalk bar that fills to what is used), this week's, what is in
// flight and waiting, and the sampling settings in force. Settings come
// from the server's environment; this shows them, it doesn't change them.

const n = (x: number) => x.toLocaleString("en-US");

export function ReppoCredits({ r }: { r: ReppoAdminDTO }) {
  const fill = useRef<HTMLSpanElement>(null);
  const share = r.settings.dailyCredits > 0 ? Math.min(1, r.today.credits / r.settings.dailyCredits) : 1;
  useLayoutEffect(() => {
    const el = fill.current;
    if (!el || window.matchMedia(REDUCED_MOTION).matches) return;
    const a = animate(el, { scaleX: { from: 0, to: 1 }, duration: 600, ease: ease.draw });
    return () => {
      a.revert();
    };
  }, [share]);
  const s = r.settings;
  return (
    <section className={styles.panel} aria-labelledby="reppo-h">
      <h2 id="reppo-h">Reppo quality checks</h2>
      {!r.on ? (
        <p className={styles.quiet}>Off: no REPPO_API_KEY on this server, so no job is scored and no second opinion is asked for.</p>
      ) : (
        <>
          <div className={styles.meter} role="img" aria-label={`${n(r.today.credits)} of ${n(s.dailyCredits)} credits used today`}>
            <span className={styles.track} />
            <span ref={fill} className={styles.fill} style={{ width: `${share * 100}%` }} />
          </div>
          <dl className={styles.facts}>
            <div>
              <dt>Today</dt>
              <dd>
                {n(r.today.credits)} of {n(s.dailyCredits)} credits, {r.today.evals} {r.today.evals === 1 ? "evaluation" : "evaluations"}
              </dd>
            </div>
            <div>
              <dt>This week</dt>
              <dd>
                {n(r.week.credits)} credits, {r.week.evals} {r.week.evals === 1 ? "evaluation" : "evaluations"}
              </dd>
            </div>
            <div>
              <dt>Being scored now</dt>
              <dd>{r.inFlight}</dd>
            </div>
            <div>
              <dt>Waiting to go</dt>
              <dd>{r.queued}</dd>
            </div>
            <div>
              <dt>Gave up today</dt>
              <dd>{r.failedToday}</dd>
            </div>
          </dl>
          {r.paused && (
            <p className={styles.note} role="status">
              {r.paused}
            </p>
          )}
          {r.budgetSpent && !r.paused && (
            <p className={styles.note} role="status">
              Today&apos;s budget is used up: no more jobs are sampled and no second opinions asked for until midnight UTC.
            </p>
          )}
        </>
      )}
      <ul className={styles.settings} aria-label="Sampling settings">
        <li>The first {s.firstJobs} finished jobs of each new version are scored, then one in {s.sampleEvery}.</li>
        <li>At most {s.weeklyPerAgent} job scores a week for each agent, free examples included.</li>
        <li>
          At most {n(s.dailyCredits)} credits a day for the whole site ({Math.floor(s.dailyCredits / r.creditsPerEval)} evaluations at {r.creditsPerEval} each).
        </li>
        <li>{s.actionOpinions ? "Second opinions on payments and new contacts that wait for a yes: on." : "Second opinions on payments and new contacts: off."}</li>
      </ul>
    </section>
  );
}
