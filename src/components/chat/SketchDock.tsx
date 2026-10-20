"use client";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { animate, createTimeline, stagger, svg, utils } from "animejs";
import {
  FIELD_KEYS,
  FIELD_LABELS,
  NODE_KEYS,
  isReady,
  linksOf,
  nodesOf,
  statusLine,
  type AgentSketch,
  type FieldKey,
  type NodeKey,
} from "@/lib/agentSketch";
import { dustIn, ease, prefersReducedMotion } from "@/lib/motion";
import styles from "./SketchDock.module.css";

// The agent sketch, docked on top of the composer as one piece: name and
// status, the watch / decide / tell you diagram, the on/off switch, and the
// details panel that opens when you tap the name.

const NODE_X: Record<NodeKey, number> = { watch: 28, decide: 104, tell: 180 };
const NODE_LABEL: Record<NodeKey, string> = { watch: "watch", decide: "decide", tell: "tell you" };
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
  onToggle: (live: boolean) => void;
}

export function SketchDock({ sketch, onToggle }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const details = useRef<HTMLUListElement>(null);
  const links = useRef<ReturnType<typeof svg.createDrawable> | null>(null);
  const before = useRef<{ nodes: string; links: string; fields: string; live: boolean } | null>(null);
  const [open, setOpen] = useState(false);
  const [paused, setPaused] = useState(false);
  const detailsId = useId();

  const nodes = nodesOf(sketch);
  const linked = linksOf(nodes);
  const ready = isReady(sketch);

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
  // run sees the state already handled.
  const nodesSig = NODE_KEYS.map((k) => nodes[k]).join();
  const linksSig = linked.join();
  const fieldsSig = FIELD_KEYS.map((k) => sketch[k].status).join();
  useLayoutEffect(() => {
    const el = root.current;
    const lines = links.current;
    if (!el || !lines) return;
    const now = { nodes: nodesSig, links: linksSig, fields: fieldsSig, live: sketch.live };
    const prev = before.current;
    before.current = now;
    const first = prev === null;
    const prevNodes = prev?.nodes.split(",") ?? [];
    const prevLinks = prev?.links.split(",") ?? [];
    const prevFields = prev?.fields.split(",") ?? [];

    const fill = (k: NodeKey) => el.querySelector(`[data-node="${k}"] [data-fill]`)!;
    const value = (k: FieldKey) => el.querySelector(`[data-field="${k}"] b`)!;
    const changedNodes = NODE_KEYS.filter((k, i) => first || prevNodes[i] !== nodes[k]);
    const changedLinks = [0, 1].filter((i) => first || prevLinks[i] !== String(linked[i]));
    const newlySet = FIELD_KEYS.filter((k, i) => sketch[k].status === "set" && prevFields[i] !== "set");

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
    if (!first && newlySet.length) tl.add(newlySet.map(value), { ...dustIn, duration: 500, ease: "out(2)" }, 0);

    // Switching on: the three dots press in turn.
    if (prev && !prev.live && sketch.live) {
      tl.add(
        NODE_KEYS.map(fill),
        { scale: [{ to: 1 }, { to: FILLED }], duration: 360, delay: stagger(110), ease: "inOut(2)" },
        0,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodesSig, linksSig, fieldsSig, sketch.live]);

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
    onToggle(next);
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
          <small>{statusLine(sketch, paused)}</small>
        </button>
        <svg className={`${styles.flow} chalky`} viewBox="0 0 208 44" aria-hidden="true" focusable="false">
          {LINK_D.map((d, i) => (
            <path key={d} className={styles.link} d={d} data-link={i} />
          ))}
          {NODE_KEYS.map((k) => (
            <g key={k} data-node={k} data-state={nodes[k]}>
              <circle className={styles.node} cx={NODE_X[k]} cy="16" r="10" />
              <circle className={styles.fill} cx={NODE_X[k]} cy="16" r="10" data-fill />
              <text x={NODE_X[k]} y="41">
                {NODE_LABEL[k]}
              </text>
            </g>
          ))}
        </svg>
        <span className="visually-hidden">
          {NODE_KEYS.map((k) => `${NODE_LABEL[k]}: ${nodes[k] === "on" ? "done" : nodes[k] === "ask" ? "waiting on you" : "not yet"}`).join(", ")}
        </span>
        <button
          type="button"
          role="switch"
          className={styles.toggle}
          aria-checked={sketch.live}
          aria-label={sketch.live ? "Switch agent off" : "Switch agent on"}
          disabled={!ready}
          onClick={flip}
        />
      </div>
      <ul className={styles.details} id={detailsId} ref={details} hidden={!open}>
        {FIELD_KEYS.map((k) => (
          <li key={k} data-field={k} data-status={sketch[k].status}>
            <small>{FIELD_LABELS[k]}</small>
            <b>{sketch[k].status === "set" ? sketch[k].value : sketch[k].status === "waiting" ? "waiting on you" : "Waiting"}</b>
          </li>
        ))}
        <li className={styles.cost}>{sketch.cost ? <Emphasis text={sketch.cost} /> : "Cost shows once it's sketched."}</li>
      </ul>
    </div>
  );
}
