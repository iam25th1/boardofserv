"use client";
import { useState } from "react";
import Link from "next/link";
import { Button, Dialog } from "@/components/ui";
import type { InstallationDTO, JobSummaryDTO } from "@/lib/types";
import { dollars } from "./JobTimeline";
import styles from "./InstallationControls.module.css";

// What an owner needs at a glance about an agent running for them, and
// their controls: run it now, pause or resume it, stop it for good (after
// a yes, since stopping can't be undone).

export type ControlAction = "pause" | "resume" | "stop" | "run";

const JOB_WORD: Record<JobSummaryDTO["status"], string> = {
  queued: "waiting to start",
  running: "running",
  waiting_for_owner: "waiting for you",
  done: "done",
  failed: "failed",
  cancelled: "stopped",
};

export function when(iso: string | null, timezone: string): string {
  if (!iso) return "not scheduled";
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: timezone, weekday: "short", hour: "numeric", minute: "2-digit", day: "numeric", month: "short" }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleString();
  }
}

export function Glance({ data, jobHref = (id) => `/jobs/${id}` }: { data: InstallationDTO; jobHref?: (jobId: string) => string }) {
  return (
    <dl className={styles.glance}>
      <div>
        <dt>Next run</dt>
        <dd>{data.status === "active" ? (data.nextRunAt ? when(data.nextRunAt, data.timezone) : "when you message it") : data.status === "paused" ? "paused" : "stopped"}</dd>
      </div>
      <div>
        <dt>Spent today</dt>
        <dd>
          {dollars(data.spendTodayUsd)} of ${data.dailySpendUsd.toFixed(2)}
        </dd>
      </div>
      <div>
        <dt>Waiting for you</dt>
        <dd>{data.approvals.length ? `${data.approvals.length} ${data.approvals.length === 1 ? "question" : "questions"}` : "nothing"}</dd>
      </div>
      <div>
        <dt>Recent jobs</dt>
        <dd>
          {data.recentJobs.length ? (
            <ol className={styles.jobs}>
              {data.recentJobs.map((j) => (
                <li key={j.id}>
                  <Link href={jobHref(j.id)} title={j.reason ?? undefined}>
                    {JOB_WORD[j.status]}
                  </Link>
                </li>
              ))}
            </ol>
          ) : (
            "none yet"
          )}
        </dd>
      </div>
    </dl>
  );
}

export function Controls({ data, onControl }: { data: InstallationDTO; onControl: (action: ControlAction) => Promise<void> }) {
  const [busy, setBusy] = useState<ControlAction | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const act = async (action: ControlAction) => {
    if (busy) return;
    setBusy(action);
    setSaid(null);
    try {
      await onControl(action);
      if (action === "run") setSaid("A job is queued: it starts as soon as it may.");
    } catch (err) {
      setSaid(err instanceof Error ? err.message : "That didn't work. Try again.");
    } finally {
      setBusy(null);
      setConfirm(false);
    }
  };
  if (data.status === "stopped") return <p className={styles.said}>Stopped for good.</p>;
  return (
    <div className={styles.controls}>
      {data.status === "active" && (
        <Button size="sm" onClick={() => void act("run")} disabled={busy !== null}>
          {busy === "run" ? "Starting..." : "Run now"}
        </Button>
      )}
      {data.status === "active" ? (
        <Button size="sm" variant="ghost" onClick={() => void act("pause")} disabled={busy !== null}>
          {busy === "pause" ? "Pausing..." : "Pause"}
        </Button>
      ) : (
        <Button size="sm" onClick={() => void act("resume")} disabled={busy !== null}>
          {busy === "resume" ? "Resuming..." : "Resume"}
        </Button>
      )}
      <Button size="sm" variant="quiet" onClick={() => setConfirm(true)} disabled={busy !== null}>
        Stop
      </Button>
      {said && (
        <span className={styles.said} role="status">
          {said}
        </span>
      )}
      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Stop it for good?"
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => setConfirm(false)}>
              Keep it
            </Button>
            <Button variant="danger" size="sm" onClick={() => void act("stop")} disabled={busy !== null}>
              {busy === "stop" ? "Stopping..." : "Stop it"}
            </Button>
          </>
        }
      >
        <p>Jobs that haven&apos;t started are cancelled, and so are questions waiting for you. A job running now finishes the step it is on, then stops. You can run the agent again from its page later.</p>
      </Dialog>
    </div>
  );
}
