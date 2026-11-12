"use client";
import type { HealLog, HealRound } from "@/lib/agents/types";
import styles from "./HealHistory.module.css";

// The details view of how an agent's builds healed themselves: every
// failure's diagnosis (where it failed, what happened, what was expected,
// and the evidence: the step's brief, its code, the review's reason, the
// check, the test run and its sample) and what the fixer did about it,
// newest first. For anyone who wants to look; the chat never shows it.

const STAGE: Record<HealRound["diagnosis"]["stage"], string> = { plan: "Working out the steps", code: "Writing a step", test: "Trying it", connect: "Connecting it", live: "Going live" };
const VERDICT: Record<NonNullable<HealRound["verdict"]>, string> = { code: "The step's code was wrong", plan: "The steps were wrong", test: "The test's sample didn't fit", unclear: "Only you could say" };
const OUTCOME: Record<HealRound["outcome"], string> = { pending: "Not acted on", fixed: "Fixed", failed: "Didn't fix it", rejected: "Turned down", asked: "Asked you" };

export function HealHistory({ heal }: { heal: HealLog }) {
  const rounds = [...heal.rounds].reverse();
  return (
    <section className={styles.section} aria-labelledby="heal-h">
      <h2 id="heal-h">How it healed itself</h2>
      <p className={styles.quiet}>
        Every time a build failed, what was wrong and what the fixer did about it, newest first.
        {heal.costUsd ? ` This build's model calls came to $${heal.costUsd.toFixed(4)}.` : ""}
      </p>
      <ol className={styles.rounds}>
        {rounds.map((r, i) => {
          const dx = r.diagnosis;
          const e = dx.evidence;
          return (
            <li key={`${dx.at}-${i}`} className={styles.round} data-outcome={r.outcome}>
              <div className={styles.head}>
                <strong>{STAGE[dx.stage]}</strong>
                {dx.step && <span className={styles.meta}>{dx.step.title}</span>}
                <span className={styles.outcome}>{OUTCOME[r.outcome]}</span>
              </div>
              <dl className={styles.facts}>
                <dt>What happened</dt>
                <dd>{dx.failure}</dd>
                <dt>What was expected</dt>
                <dd>{dx.expected}</dd>
                {r.verdict && (
                  <>
                    <dt>The fixer</dt>
                    <dd>
                      {VERDICT[r.verdict]}
                      {r.why ? `: ${r.why}` : "."}
                    </dd>
                  </>
                )}
                {r.repair && (
                  <>
                    <dt>What it did</dt>
                    <dd>{r.repair}</dd>
                  </>
                )}
                {r.rejected && (
                  <>
                    <dt>Turned down</dt>
                    <dd>{r.rejected}</dd>
                  </>
                )}
                {r.lesson && (
                  <>
                    <dt>Lesson</dt>
                    <dd>{r.lesson.text}</dd>
                  </>
                )}
              </dl>
              <details className={styles.evidence}>
                <summary>Evidence</summary>
                {e.check && <p className={styles.label}>Check: {e.check}</p>}
                {e.review && <p className={styles.label}>The review said: {e.review}</p>}
                {e.errors.length > 0 && (
                  <>
                    <p className={styles.label}>Reasons</p>
                    <pre>{e.errors.join("\n")}</pre>
                  </>
                )}
                {e.spec && (
                  <>
                    <p className={styles.label}>The step&apos;s brief</p>
                    <pre>{e.spec}</pre>
                  </>
                )}
                {e.code && (
                  <>
                    <p className={styles.label}>Its code</p>
                    <pre>{e.code}</pre>
                  </>
                )}
                {e.trace.length > 0 && (
                  <>
                    <p className={styles.label}>The test run</p>
                    <pre>{e.trace.join("\n")}</pre>
                  </>
                )}
                {e.sample && (
                  <>
                    <p className={styles.label}>The sample it ran on</p>
                    <pre>{JSON.stringify(e.sample, null, 2)}</pre>
                  </>
                )}
              </details>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
