"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui";
import { ListingPanel, type ListingBody } from "@/components/market/ListingPanel";
import { animatePop } from "@/lib/motion";
import { useStaggerIn } from "@/lib/useStaggerIn";
import { setupShapeOf } from "@/lib/agents/definition";
import { describeTriggers } from "@/lib/agents/schedule";
import { asksBefore, connectsTo, plain, stepDepths, stepLine, stepsInOrder } from "@/lib/agents/plainView";
import type { AgentBuilderDTO, AgentSummaryDTO } from "@/lib/types";
import { SetupFlow, type SetupApi } from "./SetupFlow";
import styles from "./AgentSimple.module.css";

// The agent's page with details off: what a first-time maker needs and no
// more. What the agent does, its steps as a numbered list of plain
// sentences, what it connects to, what it asks before doing, a test that
// makes its own sample data and tells the run back as a story, and
// Publish. A problem shows as one sentence with Fix this, which has SERV
// put it right with no typing. Names of values and tools, step kinds, code
// and JSON stay in the details view.

export interface SimpleApi {
  test: () => Promise<AgentSummaryDTO>;
  // Fix the problem the agent has now (agents/plainWords.ts says how).
  fix: (problem: NonNullable<AgentSummaryDTO["problem"]>) => Promise<AgentSummaryDTO>;
  publish: () => Promise<AgentBuilderDTO>;
  setup?: SetupApi & { done: (installationId: string) => void };
  list?: (body: ListingBody) => Promise<AgentBuilderDTO>;
}

// Where it stands, in a few plain words.
export function pageStatus(agent: AgentSummaryDTO): string {
  if (agent.buildState === "planning") return "Working out its steps...";
  if (agent.buildState === "fixing") return "Changing its steps...";
  if (agent.buildState === "writing") return "Building its steps...";
  if (agent.problem) return "Something needs fixing";
  if (agent.state === "published") return "Ready to run";
  return agent.test?.status === "passed" ? "Tried, not ready to run yet" : "Not tried yet";
}

export function AgentSimple({ data, api, onData }: { data: AgentBuilderDTO; api: SimpleApi; onData: (next: AgentBuilderDTO) => void }) {
  const d = data.definition;
  const agent = data.agent;
  const [busy, setBusy] = useState<"test" | "fix" | "publish" | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  // The maker's time zone, from their browser once it is open: what their
  // own runs go by (Connect sends it).
  const [zone, setZone] = useState<string | null>(null);
  useEffect(() => setZone(browserZone()), []);
  const stepsRef = useStaggerIn<HTMLOListElement>(Boolean(d));
  const storyRef = useRef<HTMLParagraphElement>(null);
  const story = agent.test?.story ?? null;
  const building = ["planning", "writing", "fixing"].includes(agent.buildState);
  const held = agent.steps.some((s) => s.code !== null && s.code !== "approved");

  // A new story arrives with a small pop, so it reads as news.
  useLayoutEffect(() => {
    if (story && storyRef.current) animatePop(storyRef.current);
  }, [story]);

  const act = async (kind: "test" | "fix" | "publish", run: () => Promise<Partial<AgentBuilderDTO>>, done?: string) => {
    setBusy(kind);
    setSaid(null);
    try {
      onData({ ...data, ...(await run()) });
      if (done) setSaid(done);
    } catch (err) {
      setSaid(err instanceof Error ? err.message : "That didn't work. Try again.");
    } finally {
      setBusy(null);
    }
  };

  if (!d) {
    return (
      <div className={styles.page}>
        <header className={styles.head}>
          <h1>{data.name}</h1>
          <p className={styles.status}>{pageStatus(agent)}</p>
        </header>
        {agent.problem ? (
          <Problem text={agent.problem.text} busy={busy === "fix"} onFix={() => void act("fix", async () => ({ agent: await api.fix(agent.problem!) }))} />
        ) : (
          <p className={styles.quiet}>
            No steps yet. Finish describing it in <Link href="/app/chat">the chat</Link>.
          </p>
        )}
      </div>
    );
  }

  const steps = stepsInOrder(d);
  const depths = stepDepths(d);
  const connects = connectsTo(d);
  const asks = asksBefore(d);
  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <h1>{data.name}</h1>
        <p className={styles.status} role="status">
          {pageStatus(agent)}
        </p>
      </header>

      {agent.problem && <Problem text={agent.problem.text} busy={busy === "fix" || building} onFix={() => void act("fix", async () => ({ agent: await api.fix(agent.problem!) }))} />}
      {/* Its self test failed, and Fix this is running on its own with what went wrong. */}
      {!agent.problem && agent.buildState === "fixing" && agent.buildNote && <Problem text={agent.buildNote} busy onFix={() => undefined} />}

      <section className={styles.section} aria-labelledby="does-h">
        <h2 id="does-h">What it does</h2>
        <p className={styles.does}>{plain(d.job.does)}</p>
      </section>

      <section className={styles.section} aria-labelledby="when-h">
        <h2 id="when-h">When it runs</h2>
        <p>
          {describeTriggers(d).join(". ")}, in your time zone{zone ? ` (${zone})` : ""}.
        </p>
      </section>

      <section className={styles.section} aria-labelledby="steps-h">
        <h2 id="steps-h">Its steps</h2>
        <ol className={styles.steps} ref={stepsRef}>
          {steps.map((s, i) => (
            <li key={s.id} data-enter data-held={agent.steps.find((x) => x.id === s.id)?.code === "needs_attention" ? "true" : undefined} style={{ "--depth": depths.get(s.id) ?? 0 } as React.CSSProperties}>
              <span className={styles.no} aria-hidden="true">
                {i + 1}
              </span>
              <span>{stepLine(s, d)}</span>
            </li>
          ))}
        </ol>
      </section>

      <div className={styles.pair}>
        <section className={styles.section} aria-labelledby="connects-h">
          <h2 id="connects-h">What it connects to</h2>
          {connects.length ? (
            <ul className={styles.tags}>
              {connects.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          ) : (
            <p className={styles.quiet}>Nothing outside: it works with what you give it at setup.</p>
          )}
        </section>
        <section className={styles.section} aria-labelledby="asks-h">
          <h2 id="asks-h">What it asks you before doing</h2>
          {asks.length ? (
            <ul className={styles.asks}>
              {asks.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          ) : (
            <p className={styles.quiet}>It doesn&apos;t stop to ask you anything.</p>
          )}
        </section>
      </div>

      <section className={styles.try} aria-labelledby="try-h">
        <div>
          <h2 id="try-h">Try it</h2>
          <p className={styles.quiet}>It makes its own sample data from its plan and runs on it. Nothing real is read, written or sent.</p>
        </div>
        <Button onClick={() => void act("test", async () => ({ agent: await api.test() }))} disabled={busy !== null || building || held}>
          {busy === "test" ? "Testing..." : agent.test ? "Test it again" : "Test it"}
        </Button>
        {story && (
          <p ref={storyRef} className={styles.story} data-status={agent.test?.status}>
            {story}
          </p>
        )}
        {agent.test?.fixed && agent.test.status === "passed" && <p className={styles.quiet}>It fixed what its first test found: {lowerFirst(agent.test.fixed)}</p>}
      </section>

      <footer className={styles.foot}>
        {agent.state === "draft" ? (
          <Button onClick={() => void act("publish", api.publish, "Published. It's in testing on your agents page.")} disabled={busy !== null || building || held || Boolean(agent.problem)}>
            {busy === "publish" ? "Publishing..." : "Publish"}
          </Button>
        ) : (
          <span className={styles.quiet}>Ready to run.</span>
        )}
        {api.setup && data.runnable && (
          <Button variant={installing ? "ghost" : "primary"} onClick={() => setInstalling(!installing)} aria-expanded={installing}>
            Run it for real
          </Button>
        )}
        {said && (
          <p className={styles.quiet} role="status">
            {said}
          </p>
        )}
      </footer>

      {installing && api.setup && data.runnable && (
        <section className={styles.section} aria-label="Run it for real">
          <h2>Run it for real</h2>
          <SetupFlow
            agentId={agent.id}
            setup={setupShapeOf(data.runnable.definition)}
            defaults={data.runnable.defaults}
            api={api.setup}
            returnTo={`/app/agents/${agent.id}?setup=1`}
            onDone={api.setup.done}
            onCancel={() => setInstalling(false)}
          />
        </section>
      )}
      {api.list && data.runnable && <ListingPanel agentId={agent.id} version={data.runnable.version} listing={data.listing} save={async (body) => onData(await api.list!(body))} />}
    </div>
  );
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

// The maker's own time zone, from their browser: what their agents run by.
function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

// What is wrong, in one sentence, and the one button that fixes it.
function Problem({ text, busy, onFix }: { text: string; busy: boolean; onFix: () => void }) {
  return (
    <div className={styles.problem} aria-live="polite">
      <p>{text}</p>
      <Button size="sm" onClick={onFix} disabled={busy}>
        {busy ? "Fixing..." : "Fix this"}
      </Button>
    </div>
  );
}
