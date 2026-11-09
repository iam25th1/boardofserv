"use client";
import { useId, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { animate, createTimeline, stagger, svg, utils } from "animejs";
import {
  FIELD_LABELS,
  fieldKeysOf,
  isReady,
  linksOf,
  nodeKeysOf,
  nodesOf,
  statusLine,
  type AgentSketch,
  type FieldKey,
  type NodeKey,
} from "@/lib/agentSketch";
import { animatePop, dustIn, ease, prefersReducedMotion } from "@/lib/motion";
import type { SketchKind } from "@/lib/sketchFields";
import styles from "./SketchDock.module.css";

// The agent sketch, docked on top of the composer as one piece: name and
// status, a small switch for its kind, the diagram (watch / decide / tell you
// for an agent, takes / does / gives for an answer helper), the on/off
// switch, and the details panel that opens when you tap the name. Agents cannot run yet, so the switch only
// works for the development fixtures (canSwitch); a real sketch keeps it
// disabled and its status line says why. A ready answer helper has a Publish
// button in the switch's place, and once published a link to its page.

// Where each of the three nodes sits, in drawing order.
const NODE_X = [28, 104, 180];
const NODE_LABEL: Record<NodeKey, string> = { watch: "watch", decide: "decide", tell: "tell you", take: "takes", do: "does", give: "gives" };
const NODE_OF: Record<FieldKey, NodeKey> = {
  watches: "watch",
  when: "decide",
  how: "decide",
  tells: "tell",
  takes: "take",
  does: "do",
  gives: "give",
};
const LINK_D = ["M28 16 C 60 8, 76 24, 104 16", "M104 16 C 132 8, 150 24, 180 16"];

const FILLED = 0.62;

function Emphasis({ text }: { text: string }) {
  return (
    <>
      {text.split(/\*\*(.+?)\*\*/).map((part, i) => (i % 2 === 1 ? <b key={i}>{part}</b> : part))}
    </>
  );
}

interface Props {
  sketch: AgentSketch;
  canSwitch?: boolean;
  // The plan call is reading the latest message into the sketch.
  sketching?: boolean;
  onToggle?: (live: boolean) => void;
  // An answer helper: the slug it is published under, while it is on the
  // board, and what Publish does.
  published?: string | null;
  onPublish?: () => void;
  // The maker switches the kind. Without it the kind is not shown.
  onKind?: (kind: SketchKind) => void;
}

// The kinds the maker can switch between, in the words the dock uses.
const KINDS: SketchKind[] = ["answer", "watcher", "digest", "helper"];

export function SketchDock({ sketch, canSwitch = false, sketching = false, onToggle, published = null, onPublish, onKind }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const details = useRef<HTMLUListElement>(null);
  const links = useRef<ReturnType<typeof svg.createDrawable> | null>(null);
  const before = useRef<{ kind: AgentSketch["kind"]; nodes: string; links: string; fields: string; values: string[]; live: boolean } | null>(null);
  const [open, setOpen] = useState(false);
  const [paused, setPaused] = useState(false);
  const detailsId = useId();

  const nodes = nodesOf(sketch);
  const nodeKeys = nodeKeysOf(sketch);
  const fieldKeys = fieldKeysOf(sketch);
  const linked = linksOf(nodes);
  const ready = isReady(sketch);
  // What sits where the switch is: the switch, Publish, or a link to the page.
  const action = sketch.kind !== "answer" ? "switch" : published ? "view" : ready ? "publish" : "switch";
  const actionRef = useRef<HTMLElement | null>(null);

  // Publish (or the link) appears in the switch's place with a small pop.
  useLayoutEffect(() => {
    if (action !== "switch" && actionRef.current) animatePop(actionRef.current);
  }, [action]);

  // The dock arrives by opening up from the composer.
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    links.current = svg.createDrawable(el.querySelectorAll("[data-link]"), 0, 0);
    if (prefersReducedMotion()) return;
    const grow = animate(el, {
      height: { from: 0, to: el.scrollHeight },
      opacity: { from: 0, to: 1 },
      duration: 400,
      ease: ease.arrive,
      onComplete: (a) => a.revert(),
    });
    return () => {
      grow.revert();
    };
  }, []);

  // Every change of state is one timeline: nodes fill (or empty), then the
  // links whose ends are both filled are drawn, and set values dust in.
  // Keyed on the state signature, so unrelated re-renders (typing in the
  // composer) never touch a running animation. No cleanup on purpose: a
  // timeline finishes even if the state moves on, and strict mode's second
  // run sees the state already handled. A change of kind redraws the
  // diagram as if seen for the first time.
  const nodesSig = nodeKeys.map((k) => nodes[k]).join();
  const linksSig = linked.join();
  const fieldsSig = fieldKeys.map((k) => sketch[k].status).join();
  const values = fieldKeys.map((k) => sketch[k].value);
  const valuesSig = JSON.stringify(values);
  useLayoutEffect(() => {
    const el = root.current;
    const lines = links.current;
    if (!el || !lines) return;
    const now = { kind: sketch.kind, nodes: nodesSig, links: linksSig, fields: fieldsSig, values, live: sketch.live };
    const prev = before.current;
    before.current = now;
    const first = prev === null || prev.kind !== sketch.kind;
    const prevNodes = prev?.nodes.split(",") ?? [];
    const prevLinks = prev?.links.split(",") ?? [];
    const prevFields = prev?.fields.split(",") ?? [];

    const fill = (k: NodeKey) => el.querySelector(`[data-node="${k}"] [data-fill]`)!;
    const value = (k: FieldKey) => el.querySelector(`[data-field="${k}"] b`)!;
    const changedNodes = nodeKeys.filter((k, i) => first || prevNodes[i] !== nodes[k]);
    const changedLinks = [0, 1].filter((i) => first || prevLinks[i] !== String(linked[i]));
    const newlySet = fieldKeys.filter((k, i) => sketch[k].status === "set" && prevFields[i] !== "set");
    // A set field whose value changed (the person changed their mind): its
    // value dusts in again and its node, already filled, presses once.
    const changedValue = fieldKeys.filter(
      (k, i) => !first && sketch[k].status === "set" && prevFields[i] === "set" && prev.values[i] !== sketch[k].value,
    );
    const pressed = [...new Set(changedValue.map((k) => NODE_OF[k]))].filter((n) => nodes[n] === "on" && !changedNodes.includes(n));

    if (prefersReducedMotion()) {
      changedNodes.forEach((k) => utils.set(fill(k), { scale: nodes[k] === "on" ? FILLED : 0 }));
      changedLinks.forEach((i) => utils.set(lines[i]!, { draw: linked[i] ? "0 1" : "0 0" }));
      return;
    }

    const tl = createTimeline({ defaults: { ease: ease.press } });
    // On first sight the nodes fill one after another, like the mockup's
    // fields landing; later changes happen together.
    changedNodes.forEach((k, i) => {
      const on = nodes[k] === "on";
      tl.add(fill(k), { scale: on ? { from: 0, to: FILLED } : { to: 0 }, duration: 450 }, first ? i * 260 : 0);
    });
    changedLinks.forEach((i) => {
      // Drawn links wait for the fills before them; erased ones go at once.
      tl.add(lines[i]!, { draw: linked[i] ? ["0 0", "0 1"] : "0 0", duration: 600, ease: ease.draw }, linked[i] ? undefined : 0);
    });
    const dusted = [...newlySet, ...changedValue];
    if (!first && dusted.length) tl.add(dusted.map(value), { ...dustIn, duration: 500, ease: "out(2)" }, 0);
    if (pressed.length) tl.add(pressed.map(fill), { scale: [{ to: 1 }, { to: FILLED }], duration: 360, ease: "inOut(2)" }, 0);

    // Switching on: the three dots press in turn.
    if (prev && !prev.live && sketch.live) {
      tl.add(
        nodeKeys.map(fill),
        { scale: [{ to: 1 }, { to: FILLED }], duration: 360, delay: stagger(110), ease: "inOut(2)" },
        0,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sketch.kind, nodesSig, linksSig, fieldsSig, valuesSig, sketch.live]);

  // The details panel opens by unfolding; it closes the same way before it
  // is hidden.
  const userOpened = useRef(false);
  useLayoutEffect(() => {
    const list = details.current;
    if (!open || !list || !userOpened.current || prefersReducedMotion()) return;
    animate(list, {
      height: { from: 0, to: list.offsetHeight },
      opacity: { from: 0, to: 1 },
      duration: 300,
      ease: ease.arrive,
      onComplete: (self) => self.revert(),
    });
  }, [open]);

  const toggleDetails = () => {
    const list = details.current;
    userOpened.current = true;
    if (!open || !list || prefersReducedMotion()) {
      setOpen(!open);
      return;
    }
    animate(list, {
      height: { from: list.offsetHeight, to: 0 },
      opacity: { from: 1, to: 0 },
      duration: 220,
      ease: "in(2)",
      onComplete: (self) => {
        list.hidden = true;
        setOpen(false);
        self.revert();
      },
    });
  };

  const flip = () => {
    const next = !sketch.live;
    if (!next) setPaused(true);
    onToggle?.(next);
  };

  return (
    <div className={styles.sketch} ref={root}>
      <div className={styles.row}>
        <button
          type="button"
          className={styles.name}
          aria-expanded={open}
          aria-controls={detailsId}
          onClick={toggleDetails}
        >
          <strong>{sketch.name || "Unnamed agent"}</strong>
          <small>
            {sketching ? <span className={styles.sketching}>sketching...</span> : statusLine(sketch, paused, canSwitch, Boolean(published))}
          </small>
        </button>
        {onKind && (
          <label className={styles.kind}>
            <span className="visually-hidden">Kind</span>
            <select
              value={sketch.kind ?? ""}
              onChange={(e) => onKind(e.target.value as SketchKind)}
              // A helper on the board keeps its kind until it is taken down.
              disabled={Boolean(published)}
              title={published ? "Take it off the board to change its kind" : "What kind of agent this is"}
            >
              {!sketch.kind && (
                <option value="" disabled>
                  kind
                </option>
              )}
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
        )}
        <svg className={`${styles.flow} chalky`} viewBox="0 0 208 44" aria-hidden="true" focusable="false">
          {LINK_D.map((d, i) => (
            <path key={d} className={styles.link} d={d} data-link={i} />
          ))}
          {nodeKeys.map((k, i) => (
            <g key={k} data-node={k} data-state={nodes[k]}>
              <circle className={styles.node} cx={NODE_X[i]} cy="16" r="10" />
              <circle className={styles.fill} cx={NODE_X[i]} cy="16" r="10" data-fill />
              <text x={NODE_X[i]} y="41">
                {NODE_LABEL[k]}
              </text>
            </g>
          ))}
        </svg>
        <span className="visually-hidden">
          {nodeKeys.map((k) => `${NODE_LABEL[k]}: ${nodes[k] === "on" ? "done" : nodes[k] === "ask" ? "waiting on you" : "not yet"}`).join(", ")}
        </span>
        {action === "view" ? (
          <Link ref={(el) => void (actionRef.current = el)} className={styles.publish} href={`/h/${published}`}>
            View
          </Link>
        ) : action === "publish" ? (
          <button
            ref={(el) => void (actionRef.current = el)}
            type="button"
            className={styles.publish}
            disabled={!onPublish}
            onClick={onPublish}
          >
            Publish
          </button>
        ) : (
          <button
            type="button"
            role="switch"
            className={styles.toggle}
            aria-checked={sketch.live}
            aria-label={canSwitch ? (sketch.live ? "Switch agent off" : "Switch agent on") : "Switch agent on (comes in the next update)"}
            disabled={!ready || !canSwitch}
            onClick={flip}
          />
        )}
      </div>
      <ul className={styles.details} id={detailsId} ref={details} hidden={!open}>
        {fieldKeys.map((k) => (
          <li key={k} data-field={k} data-status={sketch[k].status}>
            <small>{FIELD_LABELS[k]}</small>
            <b>{sketch[k].status === "set" ? sketch[k].value : sketch[k].status === "waiting" ? "waiting on you" : "Waiting"}</b>
          </li>
        ))}
        {/* No cost until agents can run; only the fixtures carry one. */}
        {sketch.cost && (
          <li className={styles.cost}>
            <Emphasis text={sketch.cost} />
          </li>
        )}
      </ul>
    </div>
  );
}
