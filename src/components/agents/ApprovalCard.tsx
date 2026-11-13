"use client";
import { useLayoutEffect, useRef, useState } from "react";
import { animate } from "animejs";
import { REDUCED_MOTION, ease } from "@/lib/motion";
import Link from "next/link";
import { Button } from "@/components/ui";
import type { ApprovalDTO } from "@/lib/types";
import styles from "./ApprovalCard.module.css";
import { moneyNote } from "@/lib/moneyWords";

// One question a job waits on: what it asks, an answer button for each
// option with what happens then, and what happens with no answer. Once
// answered (or expired) it says how it ended. For a payment or a new
// contact, Reppo's second opinion sits beside it: "still being checked"
// until it comes, never in the way of answering. On the question about
// the messages a run held, each message is listed with its links, as
// text, never as links to follow, and those Reppo called risky say so.

const ENDED: Record<Exclude<ApprovalDTO["status"], "pending">, string> = {
  answered: "Answered",
  expired: "No answer came in time",
  cancelled: "Its job was stopped",
};

export function ApprovalCard({ approval, onAnswer, jobHref }: { approval: ApprovalDTO; onAnswer: (answer: string) => Promise<void>; jobHref?: string }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const a = approval;
  const pending = a.status === "pending";

  const choose = async (label: string) => {
    if (busy) return;
    setBusy(label);
    setSaid(null);
    try {
      await onAnswer(label);
    } catch (err) {
      setSaid(err instanceof Error ? err.message : "Your answer didn't go through. Try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <article className={styles.card} data-status={a.status} aria-label={`${a.agentName} asks`}>
      <header className={styles.head}>
        <strong>{a.agentName}</strong>
        <span className={styles.meta}>
          at &quot;{a.stepTitle}&quot;
          {jobHref && (
            <>
              {" "}
              <Link href={jobHref}>see the job</Link>
            </>
          )}
        </span>
      </header>
      <p className={styles.question}>{a.question}</p>
      {a.items?.length ? (
        <ol className={styles.items} data-one={a.items.length === 1 || undefined}>
          {a.items.map((m, i) => (
            <li key={i}>
              <span>&ldquo;{m.text}&rdquo;</span>
              {m.links.length > 0 && (
                <span className={styles.links}>
                  Links:{" "}
                  {m.links.map((l, j) => (
                    <span key={j}>
                      {j > 0 && ", "}
                      <span className={styles.link}>{l.link}</span>
                      {l.risky && <strong className={styles.risky}>Reppo calls this risky</strong>}
                    </span>
                  ))}
                </span>
              )}
            </li>
          ))}
        </ol>
      ) : null}
      {a.money && <p className={styles.money}>{moneyNote(a.money)}</p>}
      {a.reason && (
        <p className={styles.reason} data-kind={a.kind}>
          <span className={styles.reasonLabel}>{a.kind === "safety" ? "Why it asks" : "Note"}</span>
          {a.reason}
        </p>
      )}
      {a.opinion && <Opinion o={a.opinion} />}
      {pending ? (
        <ul className={styles.options}>
          {a.options.map((o) => (
            <li key={o.label}>
              <Button size="sm" variant={/^(no|skip)/i.test(o.label) ? "ghost" : "primary"} onClick={() => void choose(o.label)} disabled={busy !== null}>
                {busy === o.label ? "Sending..." : o.label}
              </Button>
              <span className={styles.effect}>{o.effect}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.ended}>
          {ENDED[a.status as keyof typeof ENDED]}
          {a.answer ? `: ${a.answer}` : ""}
        </p>
      )}
      {pending && (
        <p className={styles.meta}>
          {a.noAnswer} It waits until {new Date(a.expiresAt).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}.
        </p>
      )}
      {said && (
        <p className={styles.said} role="status">
          {said}
        </p>
      )}
    </article>
  );
}

const ROUTE_WORDS = { ship: "looks fine to it", review: "it suggests a closer look", block: "it advises against it" } as const;

function Opinion({ o }: { o: NonNullable<ApprovalDTO["opinion"]> }) {
  const said = useRef<HTMLSpanElement>(null);
  // The score arriving: it settles into place (not with reduced motion).
  useLayoutEffect(() => {
    const el = said.current;
    if (!el || o.state !== "ready" || window.matchMedia(REDUCED_MOTION).matches) return;
    const a = animate(el, { opacity: { from: 0, to: 1 }, translateY: { from: 4, to: 0 }, duration: 420, ease: ease.arrive });
    return () => {
      a.revert();
    };
  }, [o.state]);
  return (
    <div className={styles.opinion} data-state={o.state} aria-live="polite">
      <span className={styles.reasonLabel}>Second opinion from Reppo</span>
      {o.state === "checking" ? (
        <span>Still being checked. You can answer now.</span>
      ) : o.state === "ready" ? (
        <span ref={said}>
          <strong>{o.score === null ? "No score" : `${o.score} out of 100`}</strong>, {o.route ? ROUTE_WORDS[o.route] : "no recommendation"}.{o.reason ? ` ${o.reason}` : ""}
        </span>
      ) : (
        <span>Not checked this time.</span>
      )}
      <small>Your answer decides: Reppo never approves or blocks anything.</small>
    </div>
  );
}
