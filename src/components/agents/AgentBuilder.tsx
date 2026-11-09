"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { Button, Textarea } from "@/components/ui";
import { animateEnter } from "@/lib/motion";
import { nextOf, setupShapeOf, type AgentDefinition, type AgentStep } from "@/lib/agents/definition";
import type { BenchData, RunEvent } from "@/lib/agents/types";
import { TOOLS } from "@/lib/agents/toolbox";
import type { AgentBuilderDTO, AgentSummaryDTO } from "@/lib/types";
import { ListingPanel, type ListingBody } from "@/components/market/ListingPanel";
import { SetupFlow, type SetupApi } from "./SetupFlow";
import { StepDiagram, type NodeState } from "./StepDiagram";
import styles from "./AgentBuilder.module.css";

// An agent's builder, for its maker: the steps as a diagram and a list (a
// code step's code included), the test bench, and fixing behaviour by
// saying what went wrong. The test bench holds sample data for every tool's
// mock; Run sends it with the run, so edits count before they are saved,
// and each step lights up on the diagram and in the trace as it happens,
// with its input, output, tool calls, time and cost.

export interface BuilderApi {
  load: () => Promise<AgentBuilderDTO>;
  run: (body: { dryRun: boolean; bench: BenchData }, on: (e: RunEvent) => void) => () => void;
  fix?: (message: string) => Promise<AgentSummaryDTO>;
  // Save draft keeps the bench's sample data; publish makes the draft a
  // version that never changes, in testing.
  saveBench?: (bench: BenchData) => Promise<AgentBuilderDTO>;
  publish?: () => Promise<AgentBuilderDTO>;
  // Set the newest published version up to run for real, for the maker:
  // the guided setup, a test run, then live (and the page moves on).
  setup?: SetupApi & { done: (installationId: string) => void };
  // Put the newest published version on the board for rent, or change it.
  list?: (body: ListingBody) => Promise<AgentBuilderDTO>;
}

const SECTIONS = [
  { key: "settings", label: "Settings", hint: "What a renter answered at setup." },
  { key: "rules", label: "Rules", hint: "Rule values for this run, as text. Empty uses the maker's defaults." },
  { key: "sheets", label: "Sheets", hint: "Each sheet's rows, for sheets.read and sheets.write." },
  { key: "pages", label: "Pages", hint: "Address to page text, for web.fetch." },
  { key: "search", label: "Search results", hint: 'Query to results, for web.search ("*" answers any other).' },
  { key: "telegram", label: "The owner's answers", hint: "What telegram.ask hears back, in order." },
  { key: "memory", label: "Memory", hint: "What the agent kept from its last job." },
  { key: "wallet", label: "Wallet", hint: "The USDC balance wallet.pay spends from." },
  { key: "decisions", label: "Recorded decisions", hint: "For a dry run: each decision step's outcome." },
] as const;
type SectionKey = (typeof SECTIONS)[number]["key"];

function textsOf(bench: BenchData): Record<SectionKey, string> {
  return Object.fromEntries(SECTIONS.map((s) => [s.key, JSON.stringify(bench[s.key], null, 2)])) as Record<SectionKey, string>;
}

// The bench from its texts, or which section isn't JSON.
export function benchFrom(texts: Record<SectionKey, string>, base: BenchData): { bench: BenchData } | { bad: SectionKey } {
  const out = { ...base } as Record<string, unknown>;
  for (const s of SECTIONS) {
    try {
      out[s.key] = JSON.parse(texts[s.key]);
    } catch {
      return { bad: s.key };
    }
  }
  return { bench: out as unknown as BenchData };
}

interface Traced {
  stepId: string;
  status: "running" | "ok" | "failed";
  input: unknown;
  output?: unknown;
  note?: string | null;
  ms?: number;
  costUsd?: number;
  tools: { tool: string; args: unknown; result: unknown; error: string | null }[];
}

function show(value: unknown): string {
  const text = JSON.stringify(value ?? null, null, 2);
  return text.length > 2000 ? `${text.slice(0, 2000)}\n...` : text;
}

const money = (usd: number) => (usd === 0 ? "$0" : usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`);
const KIND_WORD = { code: "Code", decision: "Decision", action: "Action" } as const;
const CODE_WORD = { queued: "waiting to be written", writing: "being written", reviewing: "being reviewed", approved: "approved", needs_attention: "needs your attention" } as const;

export function AgentBuilder({ initial, api, children }: { initial: AgentBuilderDTO; api: BuilderApi; children?: React.ReactNode }) {
  const [data, setData] = useState(initial);
  const [texts, setTexts] = useState(() => textsOf(initial.bench));
  const [bad, setBad] = useState<SectionKey | null>(null);
  const [dryRun, setDryRun] = useState(true);
  const [trace, setTrace] = useState<Traced[]>([]);
  const [ended, setEnded] = useState<Extract<RunEvent, { type: "end" }> | null>(null);
  const [running, setRunning] = useState(false);
  const stopRef = useRef<(() => void) | null>(null);
  const [fix, setFix] = useState("");
  const [fixing, setFixing] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const traceRef = useRef<HTMLOListElement>(null);
  const fixId = useId();
  const [busy, setBusy] = useState<"save" | "publish" | null>(null);
  const [headSaid, setHeadSaid] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  // Back from Google in the middle of setting up: carry on.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("setup") === "1") setInstalling(true);
  }, []);

  const d = data.definition;
  const building = ["planning", "writing", "fixing"].includes(data.agent.buildState);

  // While it builds, follow it.
  useEffect(() => {
    if (!building) return;
    const timer = setInterval(() => {
      api.load().then(setData, () => {});
    }, 2000);
    return () => clearInterval(timer);
  }, [api, building]);

  // A new trace row chalks in.
  const rows = trace.length;
  useEffect(() => {
    const last = traceRef.current?.lastElementChild;
    if (last) animateEnter(last, 6);
  }, [rows]);

  const run = useCallback(() => {
    const parsed = benchFrom(texts, data.bench);
    if ("bad" in parsed) {
      setBad(parsed.bad);
      return;
    }
    setBad(null);
    setTrace([]);
    setEnded(null);
    setRunning(true);
    stopRef.current = api.run({ dryRun, bench: parsed.bench }, (e) => {
      if (e.type === "step") setTrace((t) => [...t, { stepId: e.stepId, status: "running", input: e.input, tools: [] }]);
      else if (e.type === "tool") setTrace((t) => t.map((r) => (r.stepId === e.stepId && r.status === "running" ? { ...r, tools: [...r.tools, e] } : r)));
      else if (e.type === "step_done") {
        setTrace((t) => t.map((r) => (r.stepId === e.stepId && r.status === "running" ? { ...r, status: e.status, output: e.output, note: e.note, ms: e.ms, costUsd: e.costUsd } : r)));
      } else if (e.type === "end") {
        setEnded(e);
        setRunning(false);
        stopRef.current = null;
      }
    });
  }, [api, texts, data.bench, dryRun]);

  const save = async () => {
    if (!api.saveBench || busy) return;
    const parsed = benchFrom(texts, data.bench);
    if ("bad" in parsed) {
      setBad(parsed.bad);
      return;
    }
    setBad(null);
    setBusy("save");
    setHeadSaid(null);
    try {
      setData(await api.saveBench(parsed.bench));
      setHeadSaid("Draft saved.");
    } catch (err) {
      setHeadSaid(err instanceof Error ? err.message : "It could not be saved. Try again.");
    } finally {
      setBusy(null);
    }
  };

  const publish = async () => {
    if (!api.publish || busy) return;
    setBusy("publish");
    setHeadSaid(null);
    try {
      const next = await api.publish();
      setData(next);
      setHeadSaid(
        next.listing?.listed
          ? "Published. New renters get this version, and everyone renting an older one is asked to update or stay."
          : api.list
            ? "Published. Put it on the board for rent below when you're ready."
            : "Published. It's in testing on your agents page.",
      );
    } catch (err) {
      setHeadSaid(err instanceof Error ? err.message : "It could not be published. Try again.");
    } finally {
      setBusy(null);
    }
  };

  const stop = () => {
    stopRef.current?.();
    stopRef.current = null;
    setRunning(false);
  };

  const sendFix = async () => {
    if (!api.fix || !fix.trim() || fixing) return;
    setFixing(true);
    setSaid(null);
    try {
      const agent = await api.fix(fix.trim());
      setData((x) => ({ ...x, agent }));
      setFix("");
      setSaid("SERV is changing the plan. Only the steps that change are written and reviewed again.");
    } catch (err) {
      setSaid(err instanceof Error ? err.message : "That didn't work. Try again.");
    } finally {
      setFixing(false);
    }
  };

  // The diagram: a run's progress over each step's code state.
  const states: Record<string, NodeState> = {};
  for (const s of d?.steps ?? []) {
    const c = data.code[s.id];
    states[s.id] = s.kind !== "code" ? "ready" : c?.status === "approved" ? "ready" : c?.status === "needs_attention" ? "attention" : "writing";
  }
  for (const r of trace) states[r.stepId] = r.status === "running" ? "active" : r.status === "ok" ? "done" : "failed";

  return (
    <div className={styles.builder}>
      <header className={styles.head}>
        <div>
          <h1>{data.name}</h1>
          {d && <p className={styles.job}>{d.job.does}</p>}
        </div>
        <div className={styles.headSide}>
          <span className={styles.badge} data-state={data.agent.state}>
            {data.agent.state === "published" ? `In testing, version ${data.agent.version}` : `Draft, version ${data.agent.version}`}
          </span>
          {(api.saveBench || api.publish || api.setup) && (
            <div className={styles.runRow}>
              {api.saveBench && (
                <Button size="sm" variant="ghost" onClick={() => void save()} disabled={busy !== null}>
                  {busy === "save" ? "Saving..." : "Save draft"}
                </Button>
              )}
              {api.publish && data.agent.state === "draft" && (
                <Button size="sm" onClick={() => void publish()} disabled={busy !== null || building || !d}>
                  {busy === "publish" ? "Publishing..." : "Publish version"}
                </Button>
              )}
              {api.setup && data.runnable && (
                <Button size="sm" variant={installing ? "ghost" : "primary"} onClick={() => setInstalling(!installing)} aria-expanded={installing}>
                  Run it for real
                </Button>
              )}
            </div>
          )}
        </div>
      </header>
      {api.list && data.runnable && (
        <ListingPanel agentId={data.agent.id} version={data.runnable.version} listing={data.listing} save={async (body) => setData(await api.list!(body))} />
      )}
      {installing && api.setup && data.runnable && (
        <section className={styles.section} aria-label="Run it for real">
          <h2>Run version {data.runnable.version} for real</h2>
          <p className={styles.quiet}>
            A few steps, then a test run. Once live it runs on its own: on its schedule, when its value check turns true, or when you message it. Your Google
            Sheets, Telegram, web pages, web search and what it remembers are real; the wallet is still a stand-in.
          </p>
          <SetupFlow
            agentId={data.agent.id}
            setup={setupShapeOf(data.runnable.definition)}
            defaults={data.runnable.defaults}
            api={api.setup}
            returnTo={`/app/agents/${data.agent.id}?setup=1`}
            onDone={api.setup.done}
            onCancel={() => setInstalling(false)}
          />
        </section>
      )}
      {headSaid && (
        <p className={styles.quiet} role="status">
          {headSaid}
        </p>
      )}
      {children}

      {data.agent.buildNote && <p className={styles.note}>{data.agent.buildNote}</p>}
      {building && <p className={styles.building}>{data.agent.buildState === "planning" ? "planning the steps..." : data.agent.buildState === "fixing" ? "changing the plan..." : "writing the code..."}</p>}

      {!d ? (
        <p className={styles.quiet}>
          No steps yet. Finish the interview in <Link href="/app/chat">the chat</Link> and press Plan.
        </p>
      ) : (
        <>
          <section className={styles.section} aria-labelledby="steps-h">
            <h2 id="steps-h">Steps</h2>
            <StepDiagram steps={d.steps.map((s) => ({ id: s.id, title: s.title, kind: s.kind, next: nextOf(s) }))} states={states} size="full" label={`${data.name}'s steps`} />
            <ol className={styles.steps}>
              {d.steps.map((s) => (
                <StepItem key={s.id} step={s} d={d} code={data.code[s.id]} />
              ))}
            </ol>
          </section>

          <section className={styles.section} aria-labelledby="bench-h">
            <h2 id="bench-h">Test bench</h2>
            <p className={styles.quiet}>Every tool here is a mock answering from this sample data. Edit it, then run.</p>
            <div className={styles.bench}>
              <div className={styles.samples}>
                {SECTIONS.map((s) => (
                  <details key={s.key} className={styles.sample} open={s.key === "sheets" || bad === s.key}>
                    <summary>
                      {s.label}
                      {bad === s.key && <span className={styles.bad}> isn&apos;t valid JSON</span>}
                    </summary>
                    <p className={styles.hint}>{s.hint}</p>
                    <Textarea
                      className={styles.json}
                      value={texts[s.key]}
                      onChange={(e) => setTexts((t) => ({ ...t, [s.key]: e.target.value }))}
                      rows={Math.min(14, Math.max(3, texts[s.key].split("\n").length))}
                      spellCheck={false}
                      aria-label={`${s.label} sample data`}
                    />
                  </details>
                ))}
              </div>
              <div className={styles.runner}>
                <label className={styles.dry}>
                  <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} disabled={running} />
                  <span>
                    Dry run: decisions take the recorded answers, and no model is called.
                  </span>
                </label>
                <div className={styles.runRow}>
                  {running ? (
                    <Button size="sm" variant="ghost" onClick={stop}>
                      Stop
                    </Button>
                  ) : (
                    <Button size="sm" onClick={run} disabled={building}>
                      Run it
                    </Button>
                  )}
                  {!dryRun && <span className={styles.quiet}>Decisions ask SERV, within the run&apos;s {money(d.limits.maxSpendUsd)} limit.</span>}
                </div>
                <ol className={styles.trace} ref={traceRef} aria-live="polite">
                  {trace.map((r, i) => {
                    const step = d.steps.find((s) => s.id === r.stepId);
                    return (
                      <li key={`${r.stepId}-${i}`} data-status={r.status}>
                        <div className={styles.traceHead}>
                          <strong>{step?.title ?? r.stepId}</strong>
                          <span className={styles.traceMeta}>
                            {r.status === "running" ? "running..." : r.status === "ok" ? "done" : "failed"}
                            {r.ms !== undefined && `, ${r.ms} ms`}
                            {r.costUsd ? `, ${money(r.costUsd)}` : ""}
                          </span>
                        </div>
                        {r.note && <p className={styles.traceNote}>{r.note}</p>}
                        <details className={styles.io}>
                          <summary>In and out{r.tools.length ? `, ${r.tools.length} tool ${r.tools.length === 1 ? "call" : "calls"}` : ""}</summary>
                          <p className={styles.ioLabel}>Input</p>
                          <pre>{show(r.input)}</pre>
                          {r.tools.map((t, j) => (
                            <div key={j}>
                              <p className={styles.ioLabel}>
                                {t.tool}
                                {t.error ? `, failed: ${t.error}` : ""}
                              </p>
                              <pre>{show({ args: t.args, result: t.result })}</pre>
                            </div>
                          ))}
                          {r.output !== undefined && (
                            <>
                              <p className={styles.ioLabel}>Output</p>
                              <pre>{show(r.output)}</pre>
                            </>
                          )}
                        </details>
                      </li>
                    );
                  })}
                </ol>
                {ended && (
                  <p className={styles.ended} data-status={ended.status} role="status">
                    {ended.reason} {ended.steps} {ended.steps === 1 ? "step" : "steps"}, {(ended.ms / 1000).toFixed(1)} s, {money(ended.costUsd)}.
                  </p>
                )}
              </div>
            </div>
          </section>

          <section className={styles.section} aria-labelledby="versions-h">
            <h2 id="versions-h">Versions</h2>
            <p className={styles.quiet}>A published version never changes. Changing the plan or saving the bench after that starts a new draft.</p>
            <ol className={styles.versions}>
              {data.versions.map((v) => (
                <li key={v.number}>
                  <strong>Version {v.number}</strong>
                  <span className={styles.meta}>
                    {v.state === "published" && v.publishedAt ? `published ${new Date(v.publishedAt).toLocaleString()}, in testing` : `draft, started ${new Date(v.createdAt).toLocaleString()}`}
                  </span>
                </li>
              ))}
            </ol>
          </section>

          {api.fix && (
            <section className={styles.section} aria-labelledby="fix-h">
              <h2 id="fix-h">Fix it by saying what went wrong</h2>
              <label className={styles.quiet} htmlFor={fixId}>
                For example: &quot;it ignored delivery time&quot;. SERV changes the plan, and only the steps that change are written and reviewed again.
              </label>
              <Textarea id={fixId} value={fix} onChange={(e) => setFix(e.target.value)} rows={3} disabled={fixing || building} />
              <div className={styles.runRow}>
                <Button size="sm" onClick={() => void sendFix()} disabled={!fix.trim() || fixing || building}>
                  {fixing ? "Sending..." : "Change the plan"}
                </Button>
              </div>
              {said && (
                <p className={styles.quiet} role="status">
                  {said}
                </p>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}

function StepItem({ step, d, code }: { step: AgentStep; d: AgentDefinition; code?: AgentBuilderDTO["code"][string] }) {
  const [open, setOpen] = useState(false);
  const title = (id: string | null) => (id ? (d.steps.find((s) => s.id === id)?.title ?? id) : "the end");
  return (
    <li className={styles.step} data-kind={step.kind}>
      <div className={styles.stepHead}>
        <span className={styles.kind}>{KIND_WORD[step.kind]}</span>
        <strong>{step.title}</strong>
      </div>
      {step.kind === "code" && (
        <>
          <p>{step.description}</p>
          <p className={styles.meta}>Tools: {step.tools.length ? step.tools.join(", ") : "none"}</p>
          <p className={styles.meta} data-code={code?.status ?? "queued"}>
            Code {CODE_WORD[code?.status ?? "queued"]}
            {code?.status === "needs_attention" && code.note ? `: ${code.note}` : ""}
          </p>
          {code?.writer === "serv" && (
            <p className={styles.writer} title="Dolphin failed twice on this step, so SERV wrote it. SERV still reviewed it, in a call of its own.">
              written by SERV
            </p>
          )}
          {code?.source && (
            <>
              <button type="button" className={styles.toggle} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
                {open ? "Hide the code" : "Show the code"}
              </button>
              {open && <pre className={styles.code}>{code.source}</pre>}
            </>
          )}
        </>
      )}
      {step.kind === "decision" && (
        <>
          <p>{step.prompt}</p>
          <ul className={styles.outcomes}>
            {step.outcomes.map((o) => (
              <li key={o.id}>
                {o.label}, then {title(o.next)}
              </li>
            ))}
          </ul>
        </>
      )}
      {step.kind === "action" && (
        <p>
          {d.actions.find((a) => a.id === step.action)?.description ?? step.action}{" "}
          <span className={styles.meta}>({d.actions.find((a) => a.id === step.action)?.tool ?? "unknown tool"}: {TOOLS[d.actions.find((a) => a.id === step.action)?.tool ?? "telegram.send"].summary})</span>
        </p>
      )}
      <p className={styles.meta}>
        Reads {step.inputs.join(", ") || "nothing"}; gives {step.outputs.join(", ") || "nothing"}
        {step.kind !== "decision" ? `; then ${title(step.next)}` : ""}
      </p>
    </li>
  );
}
