"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { animate, stagger, svg, utils } from "animejs";
import { Button, Textarea, TextInput } from "@/components/ui";
import { GoogleConnect } from "@/components/connections/GoogleConnect";
import { TelegramLink, type LinkCode } from "@/components/connections/TelegramLink";
import { SheetField, type SheetInfo } from "@/components/agents/SheetField";
import { isSheetAnswer } from "@/lib/google/sheetLink";
import { animateEnter, dustIn, ease, prefersReducedMotion } from "@/lib/motion";
import { STAGE_NAMES, STAGES, type ConnectAnswers, type HealTone, type JourneyCard, type PlainLine } from "@/lib/journey";
import type { AgentSummaryDTO, ConnectionDTO, InstallationDTO, SketchDTO } from "@/lib/types";
import styles from "./Journey.module.css";

// The cards of the journey in the chat (lib/journey.ts), one per stage as
// it happens: what the maker described, the steps, the build, the test,
// what it needs connected, and going live. The latest card of a stage
// shows the agent as it is now, with what can be done from there; an
// earlier one shows what it showed when the journey moved on. Every word
// is plain: no plans, code, tools or versions.

export interface JourneyApi {
  makeIt: () => Promise<void>;
  looksRight: () => Promise<void>;
  change: (text: string) => Promise<void>;
  fix: (change: { message: string } | { step: string }) => Promise<void>;
  retry: () => Promise<void>;
  // Throws a ConnectProblem when some answers need another look.
  connect: (answers: ConnectAnswers) => Promise<void>;
  goLive: (body: { how: "run" } | { how: "board"; weeklyPrice: string; description: string }) => Promise<void>;
  // It gave up: a simpler version of the steps, or describing the job
  // again from the start, in a new chat.
  simpler: () => Promise<void>;
  describeAgain: () => void;
  installation: (id: string) => Promise<InstallationDTO>;
  connections: () => Promise<{ connections: ConnectionDTO[]; available: Record<"telegram" | "google", boolean> }>;
  telegramCode: () => Promise<LinkCode>;
  googleStart: (returnTo: string) => Promise<{ url: string }>;
  inspectSheet: (url: string) => Promise<SheetInfo>;
}

// What the server said was wrong with the answers, by field.
export class ConnectProblem extends Error {
  constructor(
    message: string,
    readonly errors: Record<string, string>,
  ) {
    super(message);
  }
}

interface Props {
  card: JourneyCard;
  // The latest card of its stage, and the journey hasn't moved past it.
  latest: boolean;
  agent: AgentSummaryDTO | null;
  sketch: SketchDTO | null;
  conversationId: string;
  api: JourneyApi;
}

export function JourneyCardView(p: Props) {
  switch (p.card.stage) {
    case "describe":
      return <DescribeCard {...p} />;
    case "steps":
      return <StepsCard {...p} />;
    case "build":
      return <BuildCard {...p} />;
    case "try":
      return <TryCard {...p} />;
    case "connect":
      return <ConnectCard {...p} />;
    case "live":
      return <LiveCard {...p} />;
  }
}

// One thing done at a time on a card: busy while it runs, and what went
// wrong if it didn't work.
function useAct() {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const run = useCallback(async (f: () => Promise<void>) => {
    setBusy(true);
    setSaid(null);
    try {
      await f();
    } catch (err) {
      setSaid(err instanceof Error ? err.message : "That didn't work. Try again.");
      throw err;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, said, run: (f: () => Promise<void>) => run(f).catch(() => undefined), setSaid };
}

const building = (a: AgentSummaryDTO | null) => Boolean(a && ["planning", "writing", "fixing"].includes(a.buildState));

function Frame({ card, latest, status, agentId, children }: { card: JourneyCard; latest: boolean; status?: string | null; agentId?: string | null; children: React.ReactNode }) {
  const root = useRef<HTMLElement>(null);
  const statusRef = useRef<HTMLSpanElement>(null);
  // A new card arrives with a small rise; its status line dusts in when it
  // changes, so a new state reads as news.
  useLayoutEffect(() => {
    if (latest && root.current) animateEnter(root.current, 10);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useLayoutEffect(() => {
    if (!statusRef.current || prefersReducedMotion()) return;
    animate(statusRef.current, { ...dustIn, duration: 360, ease: ease.arrive });
  }, [status]);
  const n = STAGES.indexOf(card.stage) + 1;
  return (
    <section ref={root} className={styles.card} data-latest={latest ? "true" : undefined} data-stage={card.stage} aria-label={`${n}. ${STAGE_NAMES[card.stage]}`}>
      <header className={styles.head}>
        <span className={styles.no} aria-hidden="true">
          {n}
        </span>
        <h3 className={styles.title}>{STAGE_NAMES[card.stage]}</h3>
        {status && (
          <span ref={statusRef} className={styles.status} role={latest ? "status" : undefined}>
            {status}
          </span>
        )}
      </header>
      <div className={styles.body}>{children}</div>
      {latest && agentId && (
        <Link className={styles.details} href={`/app/agents/${agentId}?details=1`}>
          Details
        </Link>
      )}
    </section>
  );
}

// Three chalk dots taking turns: something is being worked on.
function Working({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion()) return;
    const dots = el.querySelectorAll("i");
    const a = animate(dots, { opacity: [{ from: 0.25, to: 1 }, { to: 0.25 }], duration: 900, delay: stagger(180), loop: true, ease: "inOut(2)" });
    return () => {
      a.revert();
    };
  }, []);
  return (
    <p className={styles.working} role="status">
      <span ref={ref} className={styles.dots} aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {text}
    </p>
  );
}

function Said({ text }: { text: string | null }) {
  return text ? (
    <p className={styles.said} role="alert">
      {text}
    </p>
  ) : null;
}

// What the build says while it heals itself: calm plain lines, one after
// another ("Found a problem in step 1. Fixing it.", "Fixed."), each dusting
// in as it comes, a chalk tick drawn by the one that says it is fixed.
// Never a reason, a review or code: those are in Details.
export function Healing({ lines, live }: { lines: { text: string; tone: HealTone }[]; live: boolean }) {
  const ref = useRef<HTMLOListElement>(null);
  const seen = useRef(lines.length);
  useLayoutEffect(() => {
    const list = ref.current;
    if (!list) return;
    const items = [...list.querySelectorAll<HTMLLIElement>("li")];
    const fresh = items.slice(Math.min(seen.current, items.length));
    seen.current = items.length;
    const ticks = items.map((li) => li.querySelector<SVGPathElement>("path")).filter((p): p is SVGPathElement => Boolean(p));
    if (prefersReducedMotion() || !live) {
      for (const t of ticks) utils.set(svg.createDrawable(t), { draw: "0 1" });
      return;
    }
    if (fresh.length) animate(fresh, { ...dustIn, translateY: { from: 4, to: 0 }, duration: 380, delay: stagger(140), ease: ease.arrive });
    for (const li of fresh) {
      const t = li.querySelector<SVGPathElement>("path");
      if (t) animate(svg.createDrawable(t), { draw: ["0 0", "0 1"], duration: 420, delay: 200, ease: ease.draw });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines.length]);
  // Giving up is said once, with its choices (GaveUp), not in the list.
  const shown = live ? lines.filter((l) => l.tone !== "stopped") : lines;
  if (!shown.length) return null;
  return (
    <ol ref={ref} className={styles.healing} aria-label="What it fixed" aria-live={live ? "polite" : undefined}>
      {shown.map((l, i) => (
        <li key={`${i}-${l.text}`} data-tone={l.tone}>
          <span>{l.text}</span>
          {l.tone === "fixed" && (
            <svg className={styles.tick} viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
              <path d="M3 8.5 L6.5 12 L13 4.5" />
            </svg>
          )}
        </li>
      ))}
    </ol>
  );
}

// It gave up: one plain sentence of what it couldn't do, and two plain
// choices. Never a box to describe a fix, never code.
function GaveUp({ text, tries, api }: { text: string; tries: number; api: JourneyApi }) {
  const act = useAct();
  return (
    <div className={styles.box}>
      {tries > 0 && <p className={styles.quiet}>It tried {tries === 1 ? "once" : tries === 2 ? "twice" : `${tries} times`} to put it right on its own.</p>}
      <p className={styles.problem}>{text}</p>
      <div className={styles.actions}>
        <Button onClick={() => act.run(api.simpler)} disabled={act.busy}>
          {act.busy ? "Starting..." : "Try a simpler version"}
        </Button>
        <Button variant="ghost" onClick={api.describeAgain} disabled={act.busy}>
          Describe the job differently
        </Button>
      </div>
      <Said text={act.said} />
    </div>
  );
}

// How many times it set about fixing something on this card.
const triesOf = (lines: { text: string }[]) => lines.filter((l) => l.text.startsWith("Found a problem")).length;

// The lines of this card's healing: the ones said since it came in.
function healedHere(card: JourneyCard, agent: AgentSummaryDTO | null): { text: string; tone: HealTone }[] {
  return (agent?.heal?.lines ?? []).filter((l) => !card.at || l.at >= card.at).map(({ text, tone }) => ({ text, tone }));
}

function Steps({ lines, states }: { lines: PlainLine[]; states?: Record<string, RowState> }) {
  return (
    <ol className={styles.steps}>
      {lines.map((l, i) => (
        <Row key={l.id} line={l} n={i + 1} state={states?.[l.id]} />
      ))}
    </ol>
  );
}

type RowState = "waiting" | "writing" | "checking" | "done" | "held";

// One step: its number, its words, and as it is built a tick drawn in
// chalk once it is written and checked.
function Row({ line, n, state }: { line: PlainLine; n: number; state?: RowState }) {
  const tick = useRef<SVGPathElement>(null);
  const dot = useRef<HTMLSpanElement>(null);
  const was = useRef<RowState | undefined>(state);
  useLayoutEffect(() => {
    const t = tick.current;
    if (t) {
      const drawable = svg.createDrawable(t);
      if (state === "done" && was.current && was.current !== "done" && !prefersReducedMotion()) animate(drawable, { draw: ["0 0", "0 1"], duration: 420, ease: ease.draw });
      else utils.set(drawable, { draw: state === "done" ? "0 1" : "0 0" });
    }
    was.current = state;
    const d = dot.current;
    if (!d || prefersReducedMotion() || (state !== "writing" && state !== "checking" && state !== "held")) return;
    const a = animate(d, { opacity: [{ from: 0.35, to: 1 }, { to: 0.35 }], duration: 1100, loop: true, ease: "inOut(2)" });
    return () => {
      a.revert();
    };
  }, [state]);
  return (
    <li className={styles.row} data-state={state} style={{ "--depth": line.depth } as React.CSSProperties}>
      <span className={styles.rowNo} aria-hidden="true">
        {n}
      </span>
      <span className={styles.rowText}>{line.text}</span>
      {state && (
        <span className={styles.rowState}>
          {state === "writing" || state === "checking" || state === "held" ? <span ref={dot} className={styles.pulse} aria-hidden="true" /> : null}
          <svg className={styles.tick} viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
            <path ref={tick} d="M3 8.5 L6.5 12 L13 4.5" />
          </svg>
          <span className="visually-hidden">{ROW_WORDS[state]}</span>
        </span>
      )}
    </li>
  );
}

const ROW_WORDS: Record<RowState, string> = { waiting: "waiting", writing: "being written", checking: "being checked", done: "built and checked", held: "being fixed" };

// 1 Describe: what the maker said, in their words, and Make it.
const SAID_LABELS: Record<string, string> = { wakes: "When", looks: "Where it looks", handles: "What it does", finish: "Done when", asks: "Asks you first" };

function DescribeCard({ card, latest, sketch, api }: Props) {
  const act = useAct();
  const lines = latest ? (["wakes", "looks", "handles", "finish", "asks"] as const).flatMap((k) => (sketch?.[k] ? [{ id: k, text: sketch[k]!, depth: 0 }] : [])) : (card.snapshot?.lines ?? []);
  return (
    <Frame card={card} latest={latest} status={latest ? "I have what I need" : "Done"}>
      <dl className={styles.said_list}>
        {lines.map((l) => (
          <div key={l.id}>
            <dt>{SAID_LABELS[l.id] ?? ""}</dt>
            <dd>{l.text}</dd>
          </div>
        ))}
      </dl>
      {latest && (
        <>
          <p className={styles.quiet}>Make it works out its steps for you to look at. Nothing runs yet.</p>
          <div className={styles.actions}>
            <Button onClick={() => act.run(api.makeIt)} disabled={act.busy}>
              {act.busy ? "Starting..." : "Make it"}
            </Button>
          </div>
        </>
      )}
      <Said text={act.said} />
    </Frame>
  );
}

// 2 Steps: the steps in plain words, Looks right, and Change something.
function StepsCard({ card, latest, agent, api }: Props) {
  const act = useAct();
  const [changing, setChanging] = useState(false);
  const [text, setText] = useState("");
  if (!latest) {
    return (
      <Frame card={card} latest={false} status={card.snapshot?.problem ? "Didn't come together" : "Looked at"}>
        {card.snapshot?.healed && <Healing lines={card.snapshot.healed} live={false} />}
        {card.snapshot?.lines?.length ? <Steps lines={card.snapshot.lines} /> : <p className={styles.quiet}>{card.snapshot?.problem ?? "No steps came of it."}</p>}
      </Frame>
    );
  }
  const busy = building(agent);
  const lines = agent?.plain ?? [];
  const healed = healedHere(card, agent);
  // Gave up, or waiting on the maker's answer, before any steps came of it.
  const gaveUp = !lines.length ? (agent?.heal?.gaveUp ?? null) : null;
  const asking = !lines.length && !busy ? (agent?.heal?.question ?? null) : null;
  const failed = agent?.buildState === "failed" && !lines.length && !gaveUp && !asking;
  const status = busy ? (healed.length ? "Fixing them" : lines.length ? "Changing them" : "Working them out") : asking ? "One question for you" : gaveUp || failed ? "Didn't come together" : lines.length ? `${lines.length} steps` : null;
  const submit = () =>
    act.run(async () => {
      await api.change(text.trim());
      setText("");
      setChanging(false);
    });
  return (
    <Frame card={card} latest status={status} agentId={agent?.id}>
      {busy && !healed.length && <Working text={lines.length ? "Changing the steps. This takes about a minute." : "Working out the steps. This takes about a minute."} />}
      {!gaveUp && <Healing lines={healed} live />}
      {busy && healed.length > 0 && <Working text="Fixing it. This takes about a minute." />}
      {lines.length > 0 && <Steps lines={lines} />}
      {gaveUp && <GaveUp text={gaveUp} tries={triesOf(healed)} api={api} />}
      {asking && <p className={styles.quiet}>Answer the question below, and it carries on.</p>}
      {failed && (
        <>
          <p className={styles.problem}>{agent?.buildNote ?? "I couldn't work out the steps."}</p>
          <div className={styles.actions}>
            <Button onClick={() => act.run(api.makeIt)} disabled={act.busy}>
              {act.busy ? "Starting..." : "Try again"}
            </Button>
          </div>
        </>
      )}
      {!busy && lines.length > 0 && (
        <>
          {!changing && (
            <div className={styles.actions}>
              <Button onClick={() => act.run(api.looksRight)} disabled={act.busy}>
                {act.busy ? "Starting..." : "Looks right"}
              </Button>
              <Button variant="ghost" onClick={() => setChanging(true)} disabled={act.busy}>
                Change something
              </Button>
            </div>
          )}
          {changing && (
            <form
              className={styles.box}
              onSubmit={(e) => {
                e.preventDefault();
                if (text.trim()) void submit();
              }}
            >
              <label className={styles.boxLabel} htmlFor={`change-${agent?.id}`}>
                What should be different?
              </label>
              <Textarea id={`change-${agent?.id}`} value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="For example: send the reminder at 9 in the morning" />
              <div className={styles.actions}>
                <Button type="submit" disabled={act.busy || !text.trim()}>
                  {act.busy ? "Changing..." : "Change it"}
                </Button>
                <Button variant="ghost" type="button" onClick={() => setChanging(false)} disabled={act.busy}>
                  Cancel
                </Button>
              </div>
            </form>
          )}
        </>
      )}
      <Said text={act.said} />
    </Frame>
  );
}

// Where each step stands while it is built: code steps as their code goes,
// and the others ready once every code step before them is.
function rowStates(agent: AgentSummaryDTO): Record<string, RowState> {
  const out: Record<string, RowState> = {};
  let waiting = false;
  for (const l of agent.plain ?? []) {
    const code = agent.steps.find((s) => s.id === l.id)?.code ?? null;
    if (code === null) out[l.id] = waiting ? "waiting" : "done";
    else {
      out[l.id] = code === "approved" ? "done" : code === "writing" ? "writing" : code === "reviewing" ? "checking" : code === "needs_attention" ? "held" : "waiting";
      if (code !== "approved") waiting = true;
    }
  }
  return out;
}

// 3 Build: each step written and checked, one after another.
function BuildCard({ card, latest, agent, api }: Props) {
  const act = useAct();
  if (!latest || !agent) {
    const healed = card.snapshot?.healed ?? [];
    return (
      <Frame card={card} latest={false} status={card.snapshot?.problem && !healed.length ? "Stopped" : "Built and checked"}>
        <Healing lines={healed} live={false} />
        <p className={styles.quiet}>{card.snapshot?.problem && !healed.length ? card.snapshot.problem : "Every step was written and checked."}</p>
      </Frame>
    );
  }
  const lines = agent.plain ?? [];
  const states = rowStates(agent);
  const at = lines.findIndex((l) => states[l.id] === "writing" || states[l.id] === "checking");
  const healed = healedHere(card, agent);
  const busy = building(agent);
  // While it heals, a step that didn't pass its check is being fixed; when
  // it gave up here, one sentence and two choices.
  const gaveUp = !busy && healed.length ? (agent.heal?.gaveUp ?? null) : null;
  const done = lines.every((l) => states[l.id] === "done");
  const status = gaveUp ? "Stopped" : busy && healed.length ? "Fixing a step" : done ? "Built and checked" : at >= 0 ? (states[lines[at]!.id] === "checking" ? `Checking step ${at + 1}` : `Writing step ${at + 1} of ${lines.length}`) : agent.buildState === "failed" ? "Stopped" : "Getting ready";
  return (
    <Frame card={card} latest status={status} agentId={agent.id}>
      <Steps lines={lines} states={states} />
      {!gaveUp && <Healing lines={healed} live />}
      {gaveUp && <GaveUp text={gaveUp} tries={triesOf(healed)} api={api} />}
      {agent.buildState === "failed" && !gaveUp && (
        <>
          <p className={styles.quiet}>The build stopped part way.</p>
          <div className={styles.actions}>
            <Button onClick={() => act.run(api.looksRight)} disabled={act.busy}>
              Try again
            </Button>
          </div>
        </>
      )}
      <Said text={act.said} />
    </Frame>
  );
}

// 4 Try it: the test on a sample, as a short story; a failure says what
// went wrong in one sentence, with a box to say what's wrong.
function TryCard({ card, latest, agent, api }: Props) {
  const act = useAct();
  if (!latest || !agent) {
    const snap = card.snapshot;
    return (
      <Frame card={card} latest={false} status={snap?.status === "passed" ? "Passed" : snap?.status === "failed" ? "Didn't pass" : null}>
        {snap?.healed && <Healing lines={snap.healed} live={false} />}
        {snap?.story ? <p className={styles.story}>{snap.story}</p> : <p className={styles.quiet}>{snap?.problem ?? "It was tried."}</p>}
        {snap?.status === "failed" && snap.problem && !snap.healed && <p className={styles.problem}>{snap.problem}</p>}
      </Frame>
    );
  }
  const test = agent.test;
  const busy = building(agent);
  const healed = healedHere(card, agent);
  const healing = busy && healed.length > 0;
  const gaveUp = !busy && healed.length ? (agent.heal?.gaveUp ?? null) : null;
  const asking = !busy ? (agent.heal?.question ?? null) : null;
  // A test that failed with nothing healing it (an older agent): its one
  // sentence, and Fix it, which puts it right from that sentence.
  const problem = test?.status === "failed" && !busy && !gaveUp && !asking && !healed.length ? (agent.problem?.text ?? null) : null;
  const status = healing ? "Fixing it" : asking ? "One question for you" : !test ? (busy ? "Trying it" : "Stopped") : test.status === "passed" ? "Passed" : "Didn't pass";
  return (
    <Frame card={card} latest status={status} agentId={agent.id}>
      {!gaveUp && <Healing lines={healed} live />}
      {busy && !test && !healed.length && <Working text="Trying it on a sample it makes up. Nothing real is read, written or sent." />}
      {healing && <Working text="Fixing it, then trying it again. Nothing real is read, written or sent." />}
      {/* A failed run's story is for Details once it heals itself: the
          card says what it is fixing, then the run that passed. */}
      {test && (test.status === "passed" || (!busy && !healed.length)) && (
        <p className={styles.story} data-status={test.status}>
          {test.story}
        </p>
      )}
      {!test && !busy && !gaveUp && (
        <>
          <p className={styles.quiet}>The test stopped part way.</p>
          <div className={styles.actions}>
            <Button onClick={() => act.run(api.retry)} disabled={act.busy}>
              {act.busy ? "Trying..." : "Try it again"}
            </Button>
          </div>
        </>
      )}
      {gaveUp && <GaveUp text={gaveUp} tries={triesOf(healed)} api={api} />}
      {asking && <p className={styles.quiet}>Answer the question below, and it carries on.</p>}
      {problem && (
        <div className={styles.box}>
          <p className={styles.problem}>{problem}</p>
          <div className={styles.actions}>
            <Button onClick={() => act.run(() => api.fix({ message: problem }))} disabled={act.busy}>
              {act.busy ? "Fixing..." : "Fix it"}
            </Button>
          </div>
        </div>
      )}
      <Said text={act.said} />
    </Frame>
  );
}

const asText = (v: unknown): string => (v === undefined || v === null ? "" : Array.isArray(v) ? v.join(", ") : String(v));

function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

// What Connect has typed so far, kept in this tab so the way to Google and
// back picks up where it was.
function keptDraft(key: string): ConnectAnswers | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as ConnectAnswers) : null;
  } catch {
    return null;
  }
}
function keepDraft(key: string, a: ConnectAnswers | null): void {
  try {
    if (a) window.sessionStorage.setItem(key, JSON.stringify(a));
    else window.sessionStorage.removeItem(key);
  } catch {
    // Private windows: it still works, it just forgets on a reload.
  }
}

// 5 Connect: what it needs from the maker, as simple cards: Telegram, the
// sheets it works on, the answers it asks for (the page link, the target),
// and who it pays. Never a token, key or password.
function ConnectCard({ card, latest, agent, conversationId, api }: Props) {
  const setup = agent?.setup ?? null;
  const key = `bos-connect:${agent?.id ?? "none"}`;
  const fresh = useMemo<ConnectAnswers>(
    () => ({
      settings: Object.fromEntries((setup?.settings ?? []).map((s) => [s.key, s.type === "sheet" ? null : s.type === "boolean" ? false : (setup?.given[s.key] ?? "")])),
      rules: Object.fromEntries((setup?.rules ?? []).map((r) => [r.key, r.value])),
      timezone: browserZone(),
      schedule: null,
      // Who it pays: by the name the maker gave while describing it.
      payee: setup?.spends ? { label: (setup.payee ? setup.given[setup.payee] : "") ?? "", address: "" } : null,
    }),
    [setup],
  );
  const [answers, setAnswers] = useState<ConnectAnswers>(fresh);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [conn, setConn] = useState<Awaited<ReturnType<JourneyApi["connections"]>> | null>(null);
  const act = useAct();
  const saved = Boolean(card.answers);
  const open = latest && !saved && Boolean(setup);

  useEffect(() => {
    if (!open) return;
    const was = keptDraft(key);
    if (was) setAnswers(was);
  }, [open, key]);
  useEffect(() => {
    if (open) keepDraft(key, answers);
  }, [open, key, answers]);
  const refresh = useCallback(() => api.connections().then(setConn, () => undefined), [api]);
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  if (!open) {
    const said = card.answers ? Object.entries(card.answers.settings).filter(([, v]) => v !== null && v !== "" && v !== false) : [];
    return (
      <Frame card={card} latest={false} status={saved ? "Connected" : "Waiting"}>
        {saved ? (
          <ul className={styles.facts}>
            {said.map(([k, v]) => (
              <li key={k}>
                <span>{setup?.settings.find((s) => s.key === k)?.label ?? k.replace(/_/g, " ")}</span>
                <b>{isSheetAnswer(v) ? `the "${(v as { tab: string }).tab}" tab` : asText(v)}</b>
              </li>
            ))}
            {card.answers?.payee && (
              <li>
                <span>It pays</span>
                <b>{card.answers.payee.label}</b>
              </li>
            )}
            {!said.length && !card.answers?.payee && <li>It needs nothing else from you.</li>}
          </ul>
        ) : (
          <p className={styles.quiet}>Connect it once its test passes.</p>
        )}
      </Frame>
    );
  }
  // The payee's name is asked with who it pays, not on its own.
  const plainSettings = setup!.settings.filter((s) => s.type !== "sheet" && s.key !== setup!.payee);
  const sheets = setup!.settings.filter((s) => s.type === "sheet");
  const linked = (p: "telegram" | "google") => Boolean(conn?.connections.some((c) => c.provider === p));
  const set = (k: string, v: unknown) => setAnswers((a) => ({ ...a, settings: { ...a.settings, [k]: v } }));
  const err = (k: string) => (errors[k] ? <span className={styles.fieldError}>{errors[k]}</span> : null);
  const when = setup!.triggers[0]?.kind === "schedule" ? setup!.triggers[0].description : null;
  const nothing = !plainSettings.length && !sheets.length && !setup!.needs.telegram && !setup!.needs.google && !setup!.spends;
  const save = () =>
    act.run(async () => {
      setErrors({});
      try {
        await api.connect(setup!.payee && answers.payee ? { ...answers, settings: { ...answers.settings, [setup!.payee]: answers.payee.label } } : answers);
        keepDraft(key, null);
      } catch (e) {
        if (e instanceof ConnectProblem) setErrors(e.errors);
        throw e;
      }
    });
  return (
    <Frame card={card} latest status="What it needs from you" agentId={agent?.id}>
      {nothing && <p className={styles.quiet}>It needs nothing from you: no accounts, no answers.</p>}
      {setup!.needs.telegram && (
        <div className={styles.panel}>
          <h4>Your Telegram</h4>
          <p className={styles.quiet}>It messages you there{setup!.settings.length || setup!.spends ? " and asks you before it does anything you said to ask about" : ""}.</p>
          {linked("telegram") ? (
            <p className={styles.done}>Linked to {conn!.connections.find((c) => c.provider === "telegram")!.label}.</p>
          ) : conn && !conn.available.telegram ? (
            <p className={styles.quiet}>Telegram isn&apos;t set up on this server yet, so it can&apos;t message you here.</p>
          ) : (
            <TelegramLink getCode={api.telegramCode} refresh={refresh} />
          )}
          {err("telegram")}
        </div>
      )}
      {setup!.needs.google && (
        <div className={styles.panel}>
          <h4>Your Google Sheets</h4>
          {linked("google") ? (
            <p className={styles.done}>Connected as {conn!.connections.find((c) => c.provider === "google")!.label}. Paste the link of each sheet and pick its tab: those are the only tabs it can reach.</p>
          ) : conn && !conn.available.google ? (
            <p className={styles.quiet}>Google isn&apos;t set up on this server yet, so it can&apos;t reach your sheets here.</p>
          ) : (
            <GoogleConnect start={api.googleStart} returnTo={`/app/chat?c=${conversationId}`} />
          )}
          {err("google")}
          {linked("google") &&
            sheets.map((s) => (
              <div key={s.key} className={styles.field}>
                <label className={styles.fieldLabel} htmlFor={`connect-${s.key}`}>
                  {s.label}
                </label>
                <SheetField id={`connect-${s.key}`} value={isSheetAnswer(answers.settings[s.key]) ? (answers.settings[s.key] as { url: string; tab: string }) : null} onChange={(v) => set(s.key, v)} inspect={api.inspectSheet} invalid={Boolean(errors[s.key])} />
                <span className={styles.help}>{s.help}</span>
                {err(s.key)}
              </div>
            ))}
        </div>
      )}
      {plainSettings.length > 0 && (
        <div className={styles.panel}>
          <h4>Its answers</h4>
          {plainSettings.map((s) => (
            <label key={s.key} className={styles.field}>
              <span className={styles.fieldLabel}>{s.label}</span>
              {s.type === "boolean" ? (
                <input type="checkbox" checked={Boolean(answers.settings[s.key])} onChange={(e) => set(s.key, e.target.checked)} />
              ) : s.type === "choice" ? (
                <select className={styles.select} value={asText(answers.settings[s.key])} onChange={(e) => set(s.key, e.target.value)}>
                  <option value="">Pick one</option>
                  {s.choices.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              ) : (
                <TextInput
                  type={s.type === "number" ? "number" : s.type === "url" ? "url" : "text"}
                  inputMode={s.type === "number" ? "decimal" : undefined}
                  value={asText(answers.settings[s.key])}
                  placeholder={s.type === "list" ? "separated by commas" : undefined}
                  aria-invalid={Boolean(errors[s.key])}
                  onChange={(e) => set(s.key, e.target.value)}
                />
              )}
              <span className={styles.help}>
                {s.help}
                {setup!.given[s.key] ? " You said this while describing it." : ""}
              </span>
              {err(s.key)}
            </label>
          ))}
        </div>
      )}
      {setup!.spends && (
        <div className={styles.panel}>
          <h4>Who it pays</h4>
          <p className={styles.quiet}>It only ever pays this one, and asks you first. Payments are on test money.</p>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Their name</span>
            <TextInput value={answers.payee?.label ?? ""} onChange={(e) => setAnswers((a) => ({ ...a, payee: { label: e.target.value, address: a.payee?.address ?? "" } }))} />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Their wallet address</span>
            <TextInput value={answers.payee?.address ?? ""} placeholder="0x..." onChange={(e) => setAnswers((a) => ({ ...a, payee: { label: a.payee?.label ?? "", address: e.target.value.trim() } }))} aria-invalid={Boolean(errors.payee)} />
          </label>
          {err("payee")}
        </div>
      )}
      {when && (
        <p className={styles.quiet}>
          It runs {when.charAt(0).toLowerCase() + when.slice(1)}, in your time zone ({answers.timezone}).
        </p>
      )}
      <div className={styles.actions}>
        <Button onClick={() => void save()} disabled={act.busy}>
          {act.busy ? "Saving..." : "Save and go on"}
        </Button>
      </div>
      <Said text={act.said} />
    </Frame>
  );
}

function when(iso: string | null): string | null {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

// 6 Go live: run it for the maker, or put it on the board; then how it is
// doing and when it runs next.
function LiveCard({ card, latest, agent, api }: Props) {
  const act = useAct();
  const [choice, setChoice] = useState<"board" | null>(null);
  const [price, setPrice] = useState("0");
  const [description, setDescription] = useState(agent?.does ?? "");
  const [installation, setInstallation] = useState<InstallationDTO | null>(null);
  const installationId = card.live?.installationId ?? null;
  const listed = Boolean(card.live?.listed);
  useEffect(() => {
    if (installationId) void api.installation(installationId).then(setInstallation, () => undefined);
  }, [api, installationId]);
  const healed = healedHere(card, agent);
  const healing = building(agent) && healed.length > 0;
  const gaveUp = !building(agent) && healed.length ? (agent?.heal?.gaveUp ?? null) : null;
  const status = healing ? "Fixing it first" : installationId && listed ? "Running, and on the board" : installationId ? "Running for you" : listed ? "On the board" : "Ready";
  const when2 = agent?.setup?.triggers[0]?.kind === "schedule" ? agent.setup.triggers[0].description : null;
  return (
    <Frame card={card} latest={latest} status={status} agentId={agent?.id}>
      {latest && !gaveUp && <Healing lines={healed} live />}
      {latest && healing && <Working text="Fixing what the check before going live found, then going live." />}
      {latest && gaveUp && agent && <GaveUp text={gaveUp} tries={triesOf(healed)} api={api} />}
      {installationId && (
        <div className={styles.panel}>
          <h4>Running for you</h4>
          {installation ? (
            <>
              <p>
                {installation.runs.join(" ")}
                {installation.nextRunAt ? ` Next run: ${when(installation.nextRunAt)}.` : ""}
              </p>
              <Link className={styles.link} href={`/app/installations/${installationId}`}>
                See how it&apos;s doing
              </Link>
            </>
          ) : (
            <p className={styles.quiet}>Getting its next run...</p>
          )}
        </div>
      )}
      {listed && agent && (
        <div className={styles.panel}>
          <h4>On the board</h4>
          <p>Others can find it and rent it. Its page shows what it does, never how.</p>
          <Link className={styles.link} href={`/app/board/agents/${agent.id}`}>
            See its page on the board
          </Link>
        </div>
      )}
      {latest && agent && !healing && (!installationId || !listed) && (
        <div className={styles.choices}>
          {!installationId && (
            <button type="button" className={styles.choice} onClick={() => act.run(() => api.goLive({ how: "run" }))} disabled={act.busy}>
              <b>{act.busy && choice === null ? "Starting it..." : "Run it for me"}</b>
              <span>{when2 ? `It runs ${when2.charAt(0).toLowerCase() + when2.slice(1)}, with what you connected, from now on.` : "It runs with what you connected, from now on."}</span>
            </button>
          )}
          {!listed && (
            <button type="button" className={styles.choice} aria-expanded={choice === "board"} onClick={() => setChoice(choice === "board" ? null : "board")} disabled={act.busy}>
              <b>Put it on the board</b>
              <span>Others rent it and run it on their own sheets and Telegram.</span>
            </button>
          )}
        </div>
      )}
      {latest && agent && choice === "board" && !listed && (
        <form
          className={styles.box}
          onSubmit={(e) => {
            e.preventDefault();
            void act.run(async () => {
              await api.goLive({ how: "board", weeklyPrice: price, description });
              setChoice(null);
            });
          }}
        >
          <label className={styles.field}>
            <span className={styles.fieldLabel}>What it does, for people looking</span>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={400} />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Weekly price, in USDC</span>
            <TextInput value={price} inputMode="decimal" onChange={(e) => setPrice(e.target.value)} />
            <span className={styles.help}>0 is free.</span>
          </label>
          <div className={styles.preview} aria-label="How it shows on the board">
            <span className={styles.previewTag}>On the board</span>
            <b>{agent.setup?.name ?? "Your agent"}</b>
            <p>{description || "What it does."}</p>
            <span className={styles.previewPrice}>{Number(price) > 0 ? `${price} USDC a week` : "Free"}</span>
          </div>
          <div className={styles.actions}>
            <Button type="submit" disabled={act.busy}>
              {act.busy ? "Putting it there..." : "Put it on the board"}
            </Button>
          </div>
        </form>
      )}
      <Said text={act.said} />
    </Frame>
  );
}
