"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePrivy } from "@privy-io/react-auth";
import { TopBar, TopLink } from "@/components/chat/TopBar";
import { JobTimeline, type JobApi } from "@/components/agents/JobTimeline";
import { privyAppId } from "@/lib/privy-config";
import type { JobDTO } from "@/lib/types";
import { useApi } from "@/lib/useApi";
import styles from "../../agents/agents.module.css";

// One job, step by step: for its owner in full, for the agent's maker
// without the owner's data.
export default function JobPage({ params }: { params: { id: string } }) {
  return (
    <div className={styles.page}>
      <TopBar agents={<TopLink href="/installations">Running for you</TopLink>} />
      <main className={styles.col}>{privyAppId() ? <SignedIn id={params.id} /> : <p className={styles.quiet}>Sign-in isn&apos;t set up here.</p>}</main>
    </div>
  );
}

function SignedIn({ id }: { id: string }) {
  const { ready, authenticated } = usePrivy();
  if (ready && authenticated) return <Job id={id} />;
  return (
    <p className={styles.quiet}>
      <Link href="/login" aria-disabled={!ready}>
        Sign in
      </Link>{" "}
      to see this job.
    </p>
  );
}

function Job({ id }: { id: string }) {
  const api = useApi();
  const [job, setJob] = useState<JobDTO | null>(null);
  const [missing, setMissing] = useState(false);
  const jobApi = useMemo<JobApi>(
    () => ({
      load: () => api.getJob(id),
      answer: async (approvalId, answer) => void (await api.answerApproval(approvalId, answer)),
    }),
    [api, id],
  );
  useEffect(() => {
    jobApi.load().then(setJob, () => setMissing(true));
  }, [jobApi]);
  if (missing) return <p className={styles.quiet}>Nothing here.</p>;
  if (!job) return <p className={styles.loading}>getting the job</p>;
  return (
    <>
      <JobTimeline initial={job} api={jobApi} />
      {job.viewer === "owner" && (
        <p className={styles.quiet}>
          <Link href={`/installations/${job.installationId}`}>Back to the agent</Link>
        </p>
      )}
    </>
  );
}
