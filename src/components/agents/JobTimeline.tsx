"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createTimeline, stagger, svg, utils } from "animejs";
import { dustIn, ease, prefersReducedMotion } from "@/lib/motion";
import type { JobDTO, JobStepDTO } from "@/lib/types";
import { ApprovalCard } from "./ApprovalCard";
import styles from "./JobTimeline.module.css";

// A job, step by step, as a chalk timeline: a line down the side, each step
// a mark on it (a square for code, a diamond for a decision, a circle for
// an action), drawn in one after another as the job gets to it, then its
// words dusting in. A step that finished fills in; a failed one is crossed;
// one waiting for its owner stays open with the question beside it. Totals
// sit on top. The owner can open a step to see what went in and came out;
// the maker of someone else's installation sees only how it ran. With
// reduced motion everything is simply there.

export interface JobApi {
  load: () => Promise<JobDTO>;
  answer?: (approvalId: string, answer: string) => Promise<void>;
}

const POLL_MS = 2_000;
const LIVE = new Set(["queued", "running", "waiting_for_owner"]);
const STATUS_WORD: Record<JobDTO["status"], string> = {
  queued: "waiting to start",
  running: "running",
  waiting_for_owner: "waiting for your answer",
  done: "done",
  failed: "failed",
  cancelled: "stopped",
};
const STEP_WORD: Record<JobStepDTO["status"], string> = { running: "running", ok: "done", failed: "failed", waiting: "waiting for you" };

export const seconds = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`);
export const dollars = (usd: number) => (usd === 0 ? "$0" : usd < 0.01 ? `$${usd.toFixed(5)}` : `$${usd.toFixed(3)}`);

function Mark({ kind }: { kind: JobStepDTO["kind"] }) {
  if (kind === "code") return <rect x={4} y={4} width={16} height={16} rx={2} data-outline="" />;
  if (kind === "decision") return <polygon points="12,1 23,12 12,23 1,12" data-outline="" />;
  return <circle cx={12} cy={12} r={9} data-outline="" />;
}

function Value({ label, value, untrusted }: { label: string; value: unknown; untrusted?: boolean }) {
  if (value === undefined || value === null) return null;
  return (
    <div className={styles.value}>
      <span className={styles.valueLabel}>
        {label}
        {untrusted ? <span className={styles.untrusted}> from the web, untrusted</span> : null}
      </span>
      <pre>{JSON.stringify(value, null, 2).slice(0, 4000)}</pre>
    </div>
  );
}

export function JobTimeline({ initial, api }: { initial: JobDTO; api: JobApi }) {
  const [job, setJob] = useState(initial);
  const [open, setOpen] = useState<number | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const drawn = useRef<Map<number, string>>(new Map());

  useEffect(() => {
    if (!LIVE.has(job.status)) return;
    const t = setInterval(() => void api.load().then(setJob, () => undefined), POLL_MS);
    return () => clearInterval(t);
  }, [api, job.status]);

  const sig = job.steps.map((s) => `${s.seq}:${s.status}`).join();
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const fresh = job.steps.filter((s) => !drawn.current.has(s.seq));
    const changed = job.steps.filter((s) => drawn.current.has(s.seq) && drawn.current.get(s.seq) !== s.status);
    for (const s of job.steps) drawn.current.set(s.seq, s.status);
    const row = (seq: number) => list.querySelector<HTMLElement>(`[data-seq="${seq}"]`);
    if (prefersReducedMotion()) return;
    const tl = createTimeline({ defaults: { ease: ease.draw } });
    fresh.forEach((s, i) => {
      const r = row(s.seq);
      if (!r) return;
      const at = i * 260;
      const spine = r.querySelector<SVGGeometryElement>("[data-spine]");
      const outline = r.querySelector<SVGGeometryElement>("[data-outline]");
      const words = r.querySelector<HTMLElement>("[data-words]");
      if (spine) tl.add(svg.createDrawable(spine, 0, 0), { draw: ["0 0", "0 1"], duration: 220 }, at);
      if (outline) tl.add(svg.createDrawable(outline, 0, 0), { draw: ["0 0", "0 1"], duration: 320 }, at + 120);
      if (words) {
        // Hidden until its turn, so nothing shows before it is drawn.
        utils.set(words, { opacity: 0 });
        tl.add(words, { ...dustIn, duration: 320 }, at + 200);
      }
    });
    // A step that moved on (finished, failed, answered) fills with a press.
    const fills = changed.map((s) => row(s.seq)?.querySelector("[data-fill]")).filter(Boolean) as Element[];
    if (fills.length) tl.add(fills, { scale: [{ to: 1.25 }, { to: 1 }], duration: 380, ease: ease.press, delay: stagger(80) }, 0);
    // No cleanup on purpose: a step being drawn finishes even if the job moves on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  const waiting = job.approvals.filter((a) => a.status === "pending");
  const plan = new Map(job.plan.map((p) => [p.id, p]));

  return (
    <div className={styles.job}>
      <header className={styles.head}>
        <div>
          <h1>{job.agentName}</h1>
          <p className={styles.quiet}>
            Started {job.started}, {new Date(job.createdAt).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}, version {job.version}
          </p>
        </div>
        <span className={styles.status} data-status={job.status}>
          {STATUS_WORD[job.status]}
        </span>
      </header>
      <dl className={styles.totals} aria-label="Totals">
        <div>
          <dt>Steps</dt>
          <dd>{job.stepCount}</dd>
        </div>
        <div>
          <dt>Time running</dt>
          <dd>{seconds(job.ms)}</dd>
        </div>
        <div>
          <dt>Model spend</dt>
          <dd>{dollars(job.costUsd)}</dd>
        </div>
      </dl>
      {job.reason && job.status !== "done" && <p className={styles.reason}>{job.reason}</p>}
      {job.viewer === "maker" && <p className={styles.quiet}>Someone else runs this copy of your agent: you see how it ran, never what it saw or made.</p>}
      <ol className={`${styles.timeline} chalky`} ref={listRef} aria-label="The steps it ran">
        {job.steps.map((s, i) => {
          const isOpen = open === s.seq;
          const ask = s.status === "waiting" ? waiting[0] : undefined;
          return (
            <li key={s.seq} data-seq={s.seq} data-status={s.status} data-kind={s.kind} className={styles.step}>
              <svg className={styles.mark} viewBox="0 0 24 48" width={24} height={48} aria-hidden="true">
                {i > 0 && <line x1={12} y1={-2} x2={12} y2={12} data-spine="" />}
                <g transform="translate(0 12)">
                  <Mark kind={s.kind} />
                  <g className={styles.fill} data-fill="" style={{ transformOrigin: "12px 12px" }}>
                    {s.kind === "code" ? <rect x={7} y={7} width={10} height={10} rx={1} /> : s.kind === "decision" ? <polygon points="12,5 19,12 12,19 5,12" /> : <circle cx={12} cy={12} r={5} />}
                  </g>
                  {s.status === "failed" && <path d="M7 7 L17 17 M17 7 L7 17" className={styles.cross} />}
                </g>
              </svg>
              <div className={styles.words} data-words="">
                <button type="button" className={styles.title} onClick={() => setOpen(isOpen ? null : s.seq)} aria-expanded={isOpen} disabled={job.viewer !== "owner"}>
                  {s.title}
                </button>
                <span className={styles.meta}>
                  {STEP_WORD[s.status]}
                  {s.ms ? `, ${seconds(s.ms)}` : ""}
                  {s.model ? `, ${s.model}` : ""}
                  {s.costUsd ? `, ${dollars(s.costUsd)}` : ""}
                  {s.tools.length ? `, ${s.tools.map((t) => t.tool + (t.failed ? " (failed)" : "")).join(", ")}` : ""}
                  {s.outcome ? `: ${plan.get(s.stepId)?.kind === "decision" ? s.outcome.replace(/_/g, " ") : s.outcome}` : ""}
                </span>
                {s.note && <span className={styles.note}>{s.note}</span>}
                {isOpen && job.viewer === "owner" && (
                  <div className={styles.detail}>
                    <Value label="What went in" value={s.input} />
                    <Value label="What came out" value={s.output} untrusted={job.untrusted.some((k) => s.output && typeof s.output === "object" && k in (s.output as object))} />
                    {(s.calls ?? []).map((c, n) => (
                      <Value key={n} label={`${c.tool}${c.error ? `: ${c.error}` : ""}`} value={c.error ? c.args : { args: c.args, result: c.result }} untrusted={c.tool === "web.fetch" || c.tool === "web.search"} />
                    ))}
                  </div>
                )}
                {ask && api.answer && <ApprovalCard approval={ask} onAnswer={(answer) => api.answer!(ask.id, answer).then(() => api.load().then(setJob))} />}
              </div>
            </li>
          );
        })}
      </ol>
      {job.status === "queued" && <p className={styles.quiet}>It starts as soon as a worker is free and the gap since its last job has passed.</p>}
    </div>
  );
}
