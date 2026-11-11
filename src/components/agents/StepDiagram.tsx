"use client";
import { useLayoutEffect, useRef } from "react";
import { createTimeline, stagger, svg, utils } from "animejs";
import { dustIn, ease, prefersReducedMotion } from "@/lib/motion";
import type { StepKind } from "@/lib/agents/definition";
import styles from "./StepDiagram.module.css";

// An agent's real steps as a chalk diagram, in the dock and in the builder.
// A code step is a square, a decision a diamond, an action a circle, a loop
// a square with round corners that leads into its first step; links
// run from each step to the next, one per outcome from a decision, and a
// link back to an earlier step loops underneath. Steps are laid out by how
// far they are from the first.
//
// It grows as the plan forms: steps that weren't there before are chalked on
// one after another, then their links are drawn, and a step whose state
// changes (its code approved, or the test bench reaching it) fills in with a
// press. With reduced motion everything is simply in its final state.

export type NodeState = "planned" | "writing" | "ready" | "attention" | "active" | "done" | "failed";

export interface DiagramStep {
  id: string;
  title: string;
  kind: StepKind;
  // Where it goes: one step, or one per outcome; null ends the run.
  next: (string | null)[];
}

const SIZES = {
  compact: { col: 84, row: 50, r: 10, label: 11, font: 10 },
  full: { col: 124, row: 66, r: 13, label: 16, font: 11.5 },
};

const FILL: Record<NodeState, number> = { planned: 0, writing: 0, ready: 0.62, attention: 0, active: 0.4, done: 0.62, failed: 0 };

export interface Layout {
  nodes: { id: string; x: number; y: number; step: DiagramStep }[];
  links: { key: string; from: string; to: string; d: string; back: boolean }[];
  width: number;
  height: number;
}

// Columns by distance from the first step (unreachable steps after the
// rest), rows in the order steps are met.
export function layoutSteps(steps: DiagramStep[], size: keyof typeof SIZES = "compact"): Layout {
  const s = SIZES[size];
  const byId = new Map(steps.map((st) => [st.id, st]));
  const depth = new Map<string, number>();
  const order: string[] = [];
  if (steps[0]) {
    depth.set(steps[0].id, 0);
    const queue = [steps[0].id];
    while (queue.length) {
      const id = queue.shift()!;
      order.push(id);
      for (const n of byId.get(id)?.next ?? []) {
        if (n && byId.has(n) && !depth.has(n)) {
          depth.set(n, depth.get(id)! + 1);
          queue.push(n);
        }
      }
    }
  }
  let extra = Math.max(-1, ...depth.values()) + 1;
  for (const st of steps) {
    if (!depth.has(st.id)) {
      depth.set(st.id, extra++);
      order.push(st.id);
    }
  }
  const rows = new Map<number, number>();
  // Room for half a label either side of the first and last columns.
  const pad = Math.max(s.r + 30, s.col / 2 + 4);
  const nodes = order.map((id) => {
    const d = depth.get(id)!;
    const row = rows.get(d) ?? 0;
    rows.set(d, row + 1);
    return { id, x: pad + d * s.col, y: s.r + 8 + row * s.row, step: byId.get(id)! };
  });
  const at = new Map(nodes.map((n) => [n.id, n]));
  const links: Layout["links"] = [];
  for (const n of nodes) {
    for (const to of n.step.next) {
      const t = to ? at.get(to) : undefined;
      if (!t) continue;
      const back = depth.get(t.id)! <= depth.get(n.id)!;
      const key = `${n.id}>${t.id}`;
      if (links.some((l) => l.key === key)) continue;
      if (back) {
        const drop = s.row * 0.75;
        links.push({ key, from: n.id, to: t.id, back, d: `M${n.x} ${n.y + s.r} C ${n.x} ${n.y + drop}, ${t.x} ${t.y + drop}, ${t.x} ${t.y + s.r}` });
      } else {
        const mx = (n.x + t.x) / 2;
        links.push({ key, from: n.id, to: t.id, back, d: `M${n.x + s.r} ${n.y} C ${mx} ${n.y}, ${mx} ${t.y}, ${t.x - s.r} ${t.y}` });
      }
    }
  }
  const maxDepth = Math.max(0, ...nodes.map((n) => depth.get(n.id)!));
  const maxRow = Math.max(1, ...rows.values());
  const loops = links.some((l) => l.back) ? s.row * 0.6 : 0;
  return { nodes, links, width: pad * 2 + maxDepth * s.col, height: s.r * 2 + 16 + (maxRow - 1) * s.row + s.font + 8 + loops };
}

function Shape({ kind, x, y, r, ...rest }: { kind: StepKind; x: number; y: number; r: number } & React.SVGProps<SVGElement>) {
  if (kind === "code" || kind === "loop") return <rect x={x - r} y={y - r} width={r * 2} height={r * 2} rx={kind === "loop" ? r * 0.7 : 3} {...(rest as React.SVGProps<SVGRectElement>)} />;
  if (kind === "decision") {
    const k = r * 1.3;
    return <polygon points={`${x},${y - k} ${x + k},${y} ${x},${y + k} ${x - k},${y}`} {...(rest as React.SVGProps<SVGPolygonElement>)} />;
  }
  return <circle cx={x} cy={y} r={r} {...(rest as React.SVGProps<SVGCircleElement>)} />;
}

function short(title: string, max: number): string {
  return title.length <= max ? title : `${title.slice(0, max - 1).trimEnd()}...`;
}

const KIND_WORD: Record<StepKind, string> = { code: "code", decision: "decision", action: "action", loop: "loop" };
const STATE_WORD: Record<NodeState, string> = {
  planned: "planned",
  writing: "code being written",
  ready: "ready",
  attention: "needs attention",
  active: "running",
  done: "done",
  failed: "failed",
};

export function StepDiagram({
  steps,
  states = {},
  size = "compact",
  label = "The agent's steps",
}: {
  steps: DiagramStep[];
  states?: Record<string, NodeState>;
  size?: keyof typeof SIZES;
  label?: string;
}) {
  const root = useRef<SVGSVGElement>(null);
  const seen = useRef<{ ids: Set<string>; links: Set<string>; states: Record<string, NodeState> } | null>(null);
  const s = SIZES[size];
  const layout = layoutSteps(steps, size);
  const stateOf = (id: string): NodeState => states[id] ?? "planned";

  const idsSig = layout.nodes.map((n) => n.id).join();
  const linksSig = layout.links.map((l) => l.key).join();
  const statesSig = layout.nodes.map((n) => stateOf(n.id)).join();

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const prev = seen.current;
    const fresh = layout.nodes.filter((n) => !prev?.ids.has(n.id)).map((n) => n.id);
    const freshLinks = layout.links.filter((l) => !prev?.links.has(l.key)).map((l) => l.key);
    const changed = layout.nodes.filter((n) => !fresh.includes(n.id) && prev?.states[n.id] !== stateOf(n.id)).map((n) => n.id);
    seen.current = {
      ids: new Set(layout.nodes.map((n) => n.id)),
      links: new Set(layout.links.map((l) => l.key)),
      states: Object.fromEntries(layout.nodes.map((n) => [n.id, stateOf(n.id)])),
    };
    const fill = (id: string) => el.querySelector(`[data-node="${id}"] [data-fill]`);
    const scaleOf = (id: string) => FILL[stateOf(id)];

    if (prefersReducedMotion()) {
      for (const n of layout.nodes) {
        const f = fill(n.id);
        if (f) utils.set(f, { scale: scaleOf(n.id) });
      }
      return;
    }

    const outlines = fresh.map((id) => el.querySelector(`[data-node="${id}"] [data-outline]`)).filter(Boolean) as SVGGeometryElement[];
    const words = fresh.map((id) => el.querySelector(`[data-node="${id}"] text`)).filter(Boolean) as SVGTextElement[];
    const lines = freshLinks.map((k) => el.querySelector(`[data-link="${k}"]`)).filter(Boolean) as SVGGeometryElement[];
    const tl = createTimeline({ defaults: { ease: ease.draw } });
    if (outlines.length) {
      const drawn = svg.createDrawable(outlines, 0, 0);
      tl.add(drawn, { draw: ["0 0", "0 1"], duration: 420, delay: stagger(110) }, 0);
      if (words.length) tl.add(words, { ...dustIn, duration: 380, delay: stagger(110) }, 120);
    }
    if (lines.length) {
      const drawn = svg.createDrawable(lines, 0, 0);
      tl.add(drawn, { draw: ["0 0", "0 1"], duration: 520, delay: stagger(70) }, outlines.length ? 110 * outlines.length + 200 : 0);
    }
    for (const id of fresh) {
      const f = fill(id);
      if (f) utils.set(f, { scale: scaleOf(id) });
    }
    // A step whose state moved on fills (or empties) with a small press.
    for (const id of changed) {
      const f = fill(id);
      if (!f) continue;
      const to = scaleOf(id);
      tl.add(f, { scale: to > 0 ? [{ to: Math.min(1, to + 0.3) }, { to }] : { to: 0 }, duration: 380, ease: ease.press }, 0);
    }
    // No cleanup on purpose: a drawing finishes even if the plan moves on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsSig, linksSig, statesSig]);

  return (
    <div className={styles.wrap} data-size={size}>
      <svg
        ref={root}
        className={`${styles.diagram} chalky`}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        width={layout.width}
        height={layout.height}
        // Shrinks to fit its panel, down to a size still easy to read; past
        // that the panel scrolls.
        style={{ width: "100%", height: "auto", maxWidth: layout.width, minWidth: Math.min(layout.width, 520) }}
        role="img"
        aria-label={`${label}: ${steps.length} ${steps.length === 1 ? "step" : "steps"}`}
      >
        {layout.links.map((l) => (
          <path key={l.key} className={styles.link} d={l.d} data-link={l.key} data-back={l.back ? "true" : undefined} />
        ))}
        {layout.nodes.map((n) => (
          <g key={n.id} data-node={n.id} data-kind={n.step.kind} data-state={stateOf(n.id)}>
            <Shape kind={n.step.kind} x={n.x} y={n.y} r={s.r} className={styles.node} data-outline="" />
            <Shape kind={n.step.kind} x={n.x} y={n.y} r={s.r} className={styles.fill} data-fill="" />
            {stateOf(n.id) === "attention" && (
              <text className={styles.mark} x={n.x} y={n.y + 4}>
                !
              </text>
            )}
            {stateOf(n.id) === "failed" && (
              <text className={styles.mark} x={n.x} y={n.y + 4}>
                x
              </text>
            )}
            <text className={styles.label} x={n.x} y={n.y + s.r + s.font + 5} style={{ fontSize: s.font }}>
              {short(n.step.title, s.label)}
            </text>
          </g>
        ))}
      </svg>
      <ol className="visually-hidden">
        {layout.nodes.map((n) => (
          <li key={n.id}>
            {n.step.title}: {KIND_WORD[n.step.kind]} step, {STATE_WORD[stateOf(n.id)]}
          </li>
        ))}
      </ol>
    </div>
  );
}
