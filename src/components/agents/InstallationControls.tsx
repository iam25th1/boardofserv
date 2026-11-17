"use client";
import { useState } from "react";
import Link from "next/link";
import { Button, Dialog } from "@/components/ui";
import type { InstallationDTO } from "@/lib/types";
import { jobWord } from "@/lib/jobWords";
import { dollars } from "./JobTimeline";
import styles from "./InstallationControls.module.css";

// What an owner needs at a glance about an agent running for them, and
// their controls: run it now, pause or resume it, stop it for good (after
// a yes, since stopping can't be undone). While it is being set up: run a
// test, then make it live.

export type ControlAction = "pause" | "resume" | "stop" | "run" | "test" | "golive" | "recheck";


export function when(iso: string | null, timezone: string): string {
  if (!iso) return "not scheduled";
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: timezone, weekday: "short", hour: "numeric", minute: "2-digit", day: "numeric", month: "short" }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleString();
  }
}

export function Glance({ data, jobHref = (id) => `/app/jobs/${id}` }: { data: InstallationDTO; jobHref?: (jobId: string) => string }) {
  return (
    <dl className={styles.glance}>
      <div>
        <dt>Next run</dt>
        <dd>
          {data.status === "active"
            ? data.nextRunAt
              ? when(data.nextRunAt, data.timezone)
              : "when you message it"
            : data.status === "testing"
              ? "not live yet"
              : data.status === "paused"
                ? "paused"
                : "stopped"}
        </dd>
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
                  <Link href={jobHref(j.id)}>{jobWord(j)}</Link>
                  {j.why && <span className={styles.why}>{j.why}</span>}
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

// A newer version of the owner's own agent: its number, one line on what
// changed, and Switch (or, when it asks something new at setup, a way to
// set it up from its page).
export function NewerVersion({ data, onSwitch }: { data: InstallationDTO; onSwitch: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const newer = data.newer;
  if (!newer || data.status === "stopped") return null;
  const go = async () => {
    setBusy(true);
    setSaid(null);
    try {
      await onSwitch();
    } catch (err) {
      setSaid(err instanceof Error ? err.message : "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={styles.newer} role="status">
      <p>
        <strong>Version {newer.version} is ready.</strong> {newer.line}
      </p>
      {newer.breaking ? (
        <p className={styles.why}>
          {newer.breaking} <Link href={`/app/agents/${data.agentId}?setup=1`}>Set version {newer.version} up</Link>: this copy takes it over.
        </p>
      ) : (
        <Button size="sm" onClick={() => void go()} disabled={busy}>
          {busy ? "Switching..." : `Switch to version ${newer.version}`}
        </Button>
      )}
      {said && (
        <span className={styles.said} role="alert">
          {said}
        </span>
      )}
    </div>
  );
}

// Other copies of the owner's own agent running beside this one, each doing
// the same job (from before Run it for real took over the running copy):
// an offer to stop them, this one going on.
export function OtherCopies({ data, onStop }: { data: InstallationDTO; onStop: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const n = data.others ?? 0;
  if (!n || data.status === "stopped") return null;
  const stop = async () => {
    setBusy(true);
    setSaid(null);
    try {
      await onStop();
    } catch (err) {
      setSaid(err instanceof Error ? err.message : "That didn't work. Try again.");
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };
  const copies = n === 1 ? "copy" : "copies";
  return (
    <div className={styles.newer} role="status">
      <p>
        <strong>{n === 1 ? "Another copy of this agent runs" : `${n} other copies of this agent run`} beside this one,</strong> doing the same job: you may get the same message more than once.
      </p>
      <Button size="sm" variant="ghost" onClick={() => setConfirm(true)} disabled={busy}>
        Stop the other {copies}
      </Button>
      {said && (
        <span className={styles.said} role="alert">
          {said}
        </span>
      )}
      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title={`Stop the other ${copies} for good?`}
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => setConfirm(false)}>
              Keep them
            </Button>
            <Button variant="danger" size="sm" onClick={() => void stop()} disabled={busy}>
              {busy ? "Stopping..." : `Stop ${n === 1 ? "it" : "them"}`}
            </Button>
          </>
        }
      >
        <p>This one goes on as it is. What the others did stays in their history, and nothing of them runs again.</p>
      </Dialog>
    </div>
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
      if (action === "run" || action === "test") setSaid(action === "test" ? "A test run is queued: it does everything for real, once." : "A job is queued: it starts as soon as it may.");
      if (action === "golive") setSaid("It's live: it runs on its own from now on.");
      if (action === "recheck") setSaid("A run over the latest 5 is queued. Where it got to never moves back.");
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
      {data.pausedReason && (
        <p className={styles.reason} role="status">
          {data.pausedReason}
        </p>
      )}
      {data.status === "testing" && (
        <>
          <Button size="sm" onClick={() => void act("test")} disabled={busy !== null}>
            {busy === "test" ? "Starting..." : "Run a test"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void act("golive")} disabled={busy !== null}>
            {busy === "golive" ? "Going live..." : "Make it live"}
          </Button>
        </>
      )}
      {data.status === "active" && (
        <Button size="sm" onClick={() => void act("run")} disabled={busy !== null}>
          {busy === "run" ? "Starting..." : "Run now"}
        </Button>
      )}
      {data.status === "active" && data.judges && (
        <Button size="sm" variant="ghost" onClick={() => void act("recheck")} disabled={busy !== null}>
          {busy === "recheck" ? "Starting..." : "Check the latest 5 again"}
        </Button>
      )}
      {data.status === "testing" ? null : data.status === "active" ? (
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
