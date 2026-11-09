"use client";
import { useId, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { animate } from "animejs";
import { StepDiagram, type DiagramStep, type NodeState } from "@/components/agents/StepDiagram";
import { animatePop, ease, prefersReducedMotion } from "@/lib/motion";
import { INTERVIEW_FIELDS, INTERVIEW_LABELS, type SketchKind } from "@/lib/sketchFields";
import type { AgentSummaryDTO, SketchDTO } from "@/lib/types";
import { KindSwitch } from "./KindSwitch";
import styles from "./AgentDock.module.css";
import frame from "./SketchDock.module.css";

// The dock for an agent, on top of the composer like the helper's. While
// SERV interviews the maker it shows the interview: seven topics, filled in
// as they are answered, the one being asked turning. Once the agent is
// planned it shows the agent's real steps (StepDiagram), which grow as the
// plan and its code come in. Plan turns a finished interview into steps;
// Open goes to the builder and its test bench.

type Field = (typeof INTERVIEW_FIELDS)[number];

const DOT_WORD: Record<Field, string> = { wakes: "wakes", looks: "looks", handles: "acts", finish: "done", asks: "asks", setup: "setup", remembers: "keeps" };

export function interviewDone(sketch: SketchDTO): boolean {
  return INTERVIEW_FIELDS.every((k) => Boolean(sketch[k]));
}

// How the dock draws each step: its code's progress, or whether the build
// has settled.
export function stepStates(agent: AgentSummaryDTO): Record<string, NodeState> {
  const building = agent.buildState !== "idle" && agent.buildState !== "failed";
  return Object.fromEntries(
    agent.steps.map((s) => {
      if (s.kind !== "code") return [s.id, building ? "planned" : "ready"];
      if (s.code === "approved") return [s.id, "ready"];
      if (s.code === "needs_attention") return [s.id, "attention"];
      return [s.id, "writing"];
    }),
  );
}

export function diagramSteps(agent: AgentSummaryDTO): DiagramStep[] {
  return agent.steps.map((s) => ({ id: s.id, title: s.title, kind: s.kind, next: s.next }));
}

export function agentStatus(sketch: SketchDTO, agent: AgentSummaryDTO | null): string {
  if (agent) {
    if (agent.buildState === "planning") return "Planning the steps...";
    if (agent.buildState === "fixing") return "Changing the plan...";
    if (agent.buildState === "failed") return agent.buildNote ?? "The plan didn't come together. Try again.";
    const code = agent.steps.filter((s) => s.kind === "code");
    const ready = code.filter((s) => s.code === "approved").length;
    if (agent.buildState === "writing") return `Writing code, ${ready} of ${code.length} ready`;
    if (code.some((s) => s.code === "needs_attention")) return "A step needs your attention";
    if (agent.steps.length) return agent.state === "published" ? "In testing" : "Ready to test";
  }
  if (interviewDone(sketch)) return "Ready to plan";
  if (sketch.asking && (INTERVIEW_FIELDS as readonly string[]).includes(sketch.asking)) return "Waiting on one answer from you";
  return "Interviewing";
}

interface Props {
  sketch: SketchDTO;
  agent: AgentSummaryDTO | null;
  // The plan call is reading the latest message into the interview.
  sketching?: boolean;
  onKind?: (kind: SketchKind) => void;
  // Turn the finished interview into steps. Without it there is no Plan.
  onPlan?: () => void;
  planning?: boolean;
}

export function AgentDock({ sketch, agent, sketching = false, onKind, onPlan, planning = false }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const details = useRef<HTMLUListElement>(null);
  const actionRef = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const planned = Boolean(agent?.steps.length);
  const building = agent ? ["planning", "writing", "fixing"].includes(agent.buildState) : false;
  const action = planned && agent ? "open" : interviewDone(sketch) && onPlan ? "plan" : null;

  // The dock opens up from the composer, as the helper's does.
  useLayoutEffect(() => {
    const el = root.current;
    if (!el || prefersReducedMotion()) return;
    const grow = animate(el, { height: { from: 0, to: el.scrollHeight }, opacity: { from: 0, to: 1 }, duration: 400, ease: ease.arrive, onComplete: (a) => a.revert() });
    return () => {
      grow.revert();
    };
  }, []);

  // Plan, and then Open, arrive with a small pop.
  useLayoutEffect(() => {
    if (action && actionRef.current) animatePop(actionRef.current);
  }, [action]);

  return (
    <div className={frame.sketch} ref={root} data-agent-dock>
      <div className={frame.row}>
        <button type="button" className={frame.name} aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen((v) => !v)}>
          <strong>{sketch.name || "Unnamed agent"}</strong>
          <small>{sketching ? <span className={frame.sketching}>sketching...</span> : agentStatus(sketch, agent)}</small>
        </button>
        {onKind && <KindSwitch kind={sketch.kind} onKind={onKind} locked={planned ? "Planned as an agent: start a new conversation for another kind" : null} />}
        {action === "open" && agent ? (
          <Link ref={(el) => void (actionRef.current = el)} className={frame.publish} href={`/app/agents/${agent.id}`}>
            Open
          </Link>
        ) : action === "plan" ? (
          <button ref={(el) => void (actionRef.current = el)} type="button" className={frame.publish} onClick={onPlan} disabled={planning || building}>
            {planning || building ? "Planning..." : "Plan"}
          </button>
        ) : null}
      </div>
      <div className={styles.diagram}>
        {planned && agent ? <StepDiagram steps={diagramSteps(agent)} states={stepStates(agent)} label={`${sketch.name || "The agent"}'s steps`} /> : <Interview sketch={sketch} />}
      </div>
      <ul className={frame.details} id={detailsId} ref={details} hidden={!open}>
        {INTERVIEW_FIELDS.map((k) => (
          <li key={k} data-status={sketch.asking === k ? "waiting" : sketch[k] ? "set" : "empty"}>
            <small>{INTERVIEW_LABELS[k]}</small>
            <b>{sketch[k] || (sketch.asking === k ? "waiting on you" : "Waiting")}</b>
          </li>
        ))}
      </ul>
    </div>
  );
}

// The interview as seven chalk dots: filled once answered, turning while
// asked.
function Interview({ sketch }: { sketch: SketchDTO }) {
  const answered = INTERVIEW_FIELDS.filter((k) => sketch[k]).length;
  return (
    <div className={styles.interview}>
      <svg className="chalky" viewBox={`0 0 ${INTERVIEW_FIELDS.length * 40} 34`} width={INTERVIEW_FIELDS.length * 40} height={34} aria-hidden="true" focusable="false">
        {INTERVIEW_FIELDS.map((k, i) => (
          <g key={k} data-state={sketch.asking === k ? "ask" : sketch[k] ? "on" : "off"}>
            <circle className={styles.dot} cx={20 + i * 40} cy={9} r={6} />
            <text x={20 + i * 40} y={30}>
              {DOT_WORD[k]}
            </text>
          </g>
        ))}
      </svg>
      <span className="visually-hidden">
        {answered} of {INTERVIEW_FIELDS.length} answered
      </span>
    </div>
  );
}
