"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import type { JobSummaryDTO } from "@/lib/types";
import { dollars, seconds } from "./JobTimeline";
import styles from "./AgentRuns.module.css";

// The maker's view of how their agent runs for real, on every
// installation: their own jobs, and other owners' without anything of the
// owner's (no inputs, outputs or reasons).

const STATUS: Record<JobSummaryDTO["status"], string> = {
  queued: "waiting to start",
  running: "running",
  waiting_for_owner: "waiting for its owner",
  done: "done",
  failed: "failed",
  cancelled: "stopped",
};

export function AgentRuns({ load }: { load: () => Promise<JobSummaryDTO[]> }) {
  const [jobs, setJobs] = useState<JobSummaryDTO[] | null>(null);
  useEffect(() => {
    load().then(setJobs, () => setJobs([]));
  }, [load]);
  if (!jobs?.length) return null;
  return (
    <section className={styles.runs} aria-label="How it runs for real">
      <h2>How it runs for real</h2>
      <ol>
        {jobs.map((j) => (
          <li key={j.id}>
            <Link href={`/app/jobs/${j.id}`}>{STATUS[j.status]}</Link>
            <span>
              {j.mine ? "yours" : "someone else's"}, started {j.started}, {j.stepCount} {j.stepCount === 1 ? "step" : "steps"}, {seconds(j.ms)}, {dollars(j.costUsd)}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
