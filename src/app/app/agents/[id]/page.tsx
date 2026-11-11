"use client";
import { SkeletonPanel } from "@/components/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useParams } from "next/navigation";
import { usePrivy } from "@privy-io/react-auth";
import { Page } from "@/components/shell/Page";
import { AgentBuilder, type BuilderApi } from "@/components/agents/AgentBuilder";
import { AgentRuns } from "@/components/agents/AgentRuns";
import { AgentSimple, type SimpleApi } from "@/components/agents/AgentSimple";
import { useShellAccount } from "@/components/shell/AccountContext";
import { privyAppId } from "@/lib/privy-config";
import type { AgentBuilderDTO } from "@/lib/types";
import { useApi } from "@/lib/useApi";
import styles from "../agents.module.css";

// An agent's page, for its maker only: the plain view (AgentSimple) unless
// "Show details" is on, which shows the builder and test bench in full and
// is kept for the maker. The chat card's Details link opens it with details
// on for that visit.
export default function AgentPage() {
  // Next 16 passes params to a page as a promise; a client page reads them here.
  const params = useParams<{ id: string }>();
  return (
    <Page width="wide">{privyAppId() ? <SignedIn id={params.id} /> : <p className={styles.quiet}>Sign-in isn&apos;t set up here.</p>}</Page>
  );
}

function SignedIn({ id }: { id: string }) {
  const { ready, authenticated } = usePrivy();
  if (ready && authenticated) return <Builder id={id} />;
  return (
    <p className={styles.quiet}>
      <Link href="/login" aria-disabled={!ready}>
        Sign in
      </Link>{" "}
      to see this agent.
    </p>
  );
}

function Builder({ id }: { id: string }) {
  const api = useApi();
  const router = useRouter();
  const [data, setData] = useState<AgentBuilderDTO | null>(null);
  const [missing, setMissing] = useState(false);
  const builderApi = useMemo<BuilderApi>(
    () => ({
      load: () => api.getAgentBuilder(id),
      run: (body, on) => api.runAgent(id, body, on),
      fix: (message) => api.fixAgent(id, message),
      saveBench: (bench) => api.saveAgentBench(id, bench),
      publish: () => api.publishAgent(id),
      list: (body) => api.setListing(id, body),
      setup: {
        connections: api.listConnections,
        telegramCode: api.telegramCode,
        googleStart: api.googleStart,
        inspectSheet: api.inspectSheet,
        install: (answers) => api.installAgent(id, answers, { live: false }),
        control: (installationId, action) => api.controlInstallation(installationId, action),
        installation: api.getInstallation,
        job: api.getJob,
        answer: (approvalId, answer) => api.answerApproval(approvalId, answer).then(() => undefined),
        done: (installationId) => router.push(`/app/installations/${installationId}`),
      },
    }),
    [api, id, router],
  );
  const conversationId = data?.conversationId ?? null;
  const simpleApi = useMemo<SimpleApi>(
    () => ({
      test: async () => (await api.testAgent(id)).agent,
      fix: (problem) =>
        problem.fix === "rewrite" && problem.step
          ? api.rewriteStep(id, problem.step)
          : problem.fix === "plan" && conversationId
            ? api.planAgent(conversationId)
            : api.fixAgent(id, `Fix this: ${problem.text}`),
      publish: () => api.publishAgent(id),
      setup: builderApi.setup,
      list: builderApi.list,
    }),
    [api, id, builderApi, conversationId],
  );
  const loadRuns = useCallback(() => api.listAgentJobs(id), [api, id]);
  useEffect(() => {
    builderApi.load().then(setData, () => setMissing(true));
  }, [builderApi]);

  // Show details: the maker's kept choice, or on for this visit from the
  // chat card's Details link. Turning it either way keeps it.
  const shell = useShellAccount();
  const [visit, setVisit] = useState<boolean | null>(null);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("details") === "1") setVisit(true);
  }, []);
  const details = visit ?? shell.account?.agentDetails ?? false;
  const setDetails = (on: boolean) => {
    setVisit(on);
    shell.setAccount((a) => a && { ...a, agentDetails: on });
    api.setAgentDetails(on).catch(() => {});
  };

  // While it builds (a change, a rewrite), the plain view follows it; the
  // builder follows itself.
  const building = data ? ["planning", "writing", "fixing"].includes(data.agent.buildState) : false;
  useEffect(() => {
    if (!building || details) return;
    const timer = setInterval(() => {
      builderApi.load().then(setData, () => {});
    }, 2000);
    return () => clearInterval(timer);
  }, [builderApi, building, details]);

  if (missing) return <p className={styles.quiet}>Nothing here.</p>;
  if (!data) return <SkeletonPanel label="Getting the agent" lines={7} />;
  return (
    <>
      <div className={styles.viewBar}>
        <label className={styles.detailsSwitch}>
          <span>Show details</span>
          <button type="button" role="switch" aria-checked={details} className={styles.switch} onClick={() => setDetails(!details)} />
        </label>
      </div>
      {details ? (
        <>
          <AgentBuilder key="details" initial={data} api={builderApi} />
          <AgentRuns load={loadRuns} />
        </>
      ) : (
        <AgentSimple
          data={data}
          api={simpleApi}
          onData={(next) => {
            setData(next);
            // After a fix or a test the full picture is a reload away.
            builderApi.load().then(setData, () => {});
          }}
        />
      )}
    </>
  );
}
