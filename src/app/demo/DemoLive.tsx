"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { InstallationView, type InstallationApi } from "@/components/agents/InstallationView";
import { JobTimeline, type JobApi } from "@/components/agents/JobTimeline";
import type { InstallationDTO, JobDTO, JobSummaryDTO } from "@/lib/types";
import styles from "../agents/agents.module.css";

// /demo?agent=restock&live=1, development only: the example agent installed
// for a test owner and running for real on an in-memory database inside the
// development server (lib/agents/demoLive.ts), every 90 seconds, against
// stand-in sheets and a suppliers' page the demo serves itself. Its
// installation's page, and its latest job drawn step by step with the
// question to answer.

interface State {
  installation: InstallationDTO;
  jobs: JobSummaryDTO[];
  job: JobDTO | null;
  everyMs: number;
}

const BASE = "/api/demo/agent/live";

async function call(path: string, init?: RequestInit): Promise<State> {
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json" } });
  const body = (await res.json().catch(() => ({}))) as State & { error?: string };
  if (!res.ok) throw new Error(body.error ?? "The demo didn't answer.");
  return body;
}

export function DemoLive({ jobId }: { jobId?: string }) {
  const [state, setState] = useState<State | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(jobId ?? null);
  const load = useCallback(() => call(`${BASE}${picked ? `?job=${picked}` : ""}`), [picked]);

  useEffect(() => {
    load().then(setState, (err: unknown) => setFailed(err instanceof Error ? err.message : "The demo didn't start."));
  }, [load]);
  // Follow the newest job unless one was picked.
  useEffect(() => {
    if (picked) return;
    const t = setInterval(() => void load().then(setState, () => undefined), 3_000);
    return () => clearInterval(t);
  }, [load, picked]);

  const act = useCallback(async (body: object) => {
    const next = await call(BASE, { method: "POST", body: JSON.stringify(body) });
    setState(next);
    return next;
  }, []);

  const installApi = useMemo<InstallationApi>(
    () => ({
      load: async () => (await load()).installation,
      messages: async () => [],
      send: async () => {
        throw new Error("This agent doesn't take messages.");
      },
      control: async (action) => (await act({ action })).installation,
      answer: async (approvalId, answer) => void (await act({ action: "answer", approvalId, answer })),
      jobHref: (id) => `/demo?agent=restock&live=1&job=${id}`,
    }),
    [load, act],
  );
  const jobApi = useMemo<JobApi>(
    () => ({
      load: async () => {
        const s = await load();
        if (!s.job) throw new Error("No job yet.");
        return s.job;
      },
      answer: async (approvalId, answer) => void (await act({ action: "answer", approvalId, answer })),
    }),
    [load, act],
  );

  if (failed) return <p className={styles.quiet}>{failed}</p>;
  if (!state) return <p className={styles.loading}>starting the example on an in-memory database</p>;
  return (
    <>
      <p className={styles.note}>
        Development demo: the example agent runs for a test owner every {Math.round(state.everyMs / 1000)} seconds (not while it waits for you), against stand-in sheets and{" "}
        <a href={`${BASE}?page=prices`} target="_blank" rel="noreferrer">
          a suppliers&apos; page
        </a>{" "}
        it fetches for real. A stand-in for SERV makes its decisions, so no model is called.
      </p>
      <InstallationView initial={state.installation} api={installApi} />
      {state.job ? (
        <section aria-label="Its latest job">
          {picked && (
            <p className={styles.quiet}>
              <a
                href="/demo?agent=restock&live=1"
                onClick={(e) => {
                  e.preventDefault();
                  setPicked(null);
                }}
              >
                Follow the newest job
              </a>
            </p>
          )}
          <JobTimeline key={state.job.id} initial={state.job} api={jobApi} />
        </section>
      ) : (
        <p className={styles.loading}>its first job starts in a moment</p>
      )}
    </>
  );
}
