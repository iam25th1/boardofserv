"use client";
import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui";
import type { ApprovalDTO } from "@/lib/types";
import styles from "./ApprovalCard.module.css";

// One question a job waits on: what it asks, an answer button for each
// option with what happens then, and what happens with no answer. Once
// answered (or expired) it says how it ended.

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
      {a.reason && (
        <p className={styles.reason} data-kind={a.kind}>
          <span className={styles.reasonLabel}>{a.kind === "safety" ? "Why it asks" : "Note"}</span>
          {a.reason}
        </p>
      )}
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
