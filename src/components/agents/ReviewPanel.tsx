"use client";
import type { VersionReviewDTO } from "@/lib/types";
import styles from "./ReviewPanel.module.css";

// A version's code review, for its maker (and admins): whether it passed,
// and each finding in plain words, blocking ones first. A blocking finding
// keeps the version from being published until it is fixed.

const STATUS = {
  passed: "Passed the code review",
  blocked: "Fix these before it can be published",
  unreviewed: "Not reviewed yet",
} as const;

export function ReviewPanel({ review, fixHint }: { review: VersionReviewDTO; fixHint?: boolean }) {
  const findings = [...review.findings].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "blocking" ? -1 : 1));
  return (
    <section className={styles.panel} data-status={review.status} aria-labelledby="review-h">
      <div className={styles.head}>
        <h2 id="review-h">Code review</h2>
        <span className={styles.status} data-status={review.status}>
          {STATUS[review.status]}
        </span>
      </div>
      {findings.length ? (
        <ol className={styles.findings}>
          {findings.map((f, i) => (
            <li key={i} data-severity={f.severity}>
              <span className={styles.severity}>{f.severity === "blocking" ? "must fix" : "worth a look"}</span>
              <span className={styles.step}>{f.step}</span>
              <p>{f.finding}</p>
            </li>
          ))}
        </ol>
      ) : (
        <p className={styles.quiet}>{review.status === "passed" ? "SERV read every code step against what the agent is for and found nothing to fix." : "No findings."}</p>
      )}
      <p className={styles.quiet}>
        {review.by === "serv" ? "Read by SERV and the plain checks" : "Plain checks only: SERV couldn't read it"}, {new Date(review.reviewedAt).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}.
        {fixHint && review.status === "blocked" ? " Say what to change below and SERV changes the plan; the steps that change are written again." : ""}
      </p>
    </section>
  );
}
