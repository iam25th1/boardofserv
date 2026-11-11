"use client";
import { useLayoutEffect, useRef } from "react";
import { animate, createScope, createTimeline, stagger, svg, utils } from "animejs";
import { REDUCED_MOTION, ease } from "@/lib/motion";
import { useTapGuard } from "@/lib/useTapGuard";
import styles from "./EmptyState.module.css";

// The first screen: one plain sentence on what boardofserv does, and three
// jobs it does well to start from, each a clearly bordered button. Tapping
// one sends it as a real message; a touch that scrolls doesn't. Nothing
// else competes: the stage tracker above it, faint, shows the way ahead.

const IDEAS = [
  {
    k: "every morning",
    t: "Send me a short motivational line on Telegram at 8",
    send: "Every morning at 8, send me a Telegram message with a short motivational line for the day.",
    d: "M0 5 C 25 2, 60 8, 100 4",
  },
  {
    k: "watch a price",
    t: "Tell me when a product drops below my target price",
    send: "Every day, check a product page I give you and read its price. If the price is below a target I set, ask me on Telegram whether I want a reminder to buy it, and only send the reminder if I say yes.",
    d: "M0 4 C 30 7, 55 1, 100 5",
  },
  {
    k: "sort a sheet",
    t: "Mark new enquiries in my sheet urgent or not",
    send: "Every hour, check my Google Sheet of customer enquiries for new rows. For each new row, decide whether it's urgent or not urgent, and write the answer in a Priority column of that row. Leave rows I've already checked alone.",
    d: "M0 5 C 20 3, 70 7, 100 3",
  },
];

export function EmptyState({ onPick, disabled }: { onPick: (text: string) => void; disabled?: boolean }) {
  const root = useRef<HTMLDivElement>(null);

  // Layout effect: the hidden starting state is applied before first paint.
  useLayoutEffect(() => {
    const scope = createScope({ root, mediaQueries: { reduce: REDUCED_MOTION } }).add((self) => {
      const reduce = Boolean(self?.matches.reduce);
      const underlines = [...(root.current?.querySelectorAll<HTMLButtonElement>("[data-idea]") ?? [])].map((button) => ({
        button,
        line: svg.createDrawable(button.querySelector("path")!, 0, 0),
      }));

      // Arrival: the sentence rises, then the examples arrive one after
      // another.
      if (!reduce) {
        utils.set(["h1", "[data-idea]"], { opacity: 0 });
        createTimeline({ defaults: { ease: ease.arrive } })
          .add("h1", { opacity: { from: 0, to: 1 }, translateY: { from: 10, to: 0 }, duration: 420 })
          .add(
            "[data-idea]",
            { opacity: { from: 0, to: 1 }, translateY: { from: 8, to: 0 }, duration: 380, delay: stagger(70) },
            "-=160",
          );
      }

      // The chalk underline draws on hover and focus and wipes away after.
      const cleanups = underlines.map(({ button, line }) => {
        const show = () => {
          if (reduce) utils.set(line, { draw: "0 1" });
          else animate(line, { draw: "0 1", duration: 500, ease: ease.draw });
        };
        const hide = () => {
          if (button.matches(":hover") || button === document.activeElement) return;
          if (reduce) utils.set(line, { draw: "0 0" });
          else animate(line, { draw: "0 0", duration: 300, ease: "out(2)" });
        };
        button.addEventListener("pointerenter", show);
        button.addEventListener("focus", show);
        button.addEventListener("pointerleave", hide);
        button.addEventListener("blur", hide);
        return () => {
          button.removeEventListener("pointerenter", show);
          button.removeEventListener("focus", show);
          button.removeEventListener("pointerleave", hide);
          button.removeEventListener("blur", hide);
        };
      });
      return () => cleanups.forEach((off) => off());
    });
    return () => scope.revert();
  }, []);

  return (
    <div className={styles.scroll}>
      <section className={styles.empty} ref={root}>
        <h1>Tell boardofserv a job in your own words, and it makes an agent that does it for you.</h1>
        <ul className={styles.ideas} aria-label="Jobs to start from">
          {IDEAS.map((idea) => (
            <li key={idea.k}>
              <Idea idea={idea} disabled={disabled} onPick={onPick} />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

// One example: a bordered button with a press state. It counts only as a
// tap that didn't move, so scrolling past it never sends it.
function Idea({ idea, disabled, onPick }: { idea: (typeof IDEAS)[number]; disabled?: boolean; onPick: (text: string) => void }) {
  const tap = useTapGuard(() => onPick(idea.send));
  return (
    <button type="button" className={styles.idea} data-idea disabled={disabled} {...tap}>
      <span className={styles.k}>{idea.k}</span>
      <span className={styles.t}>{idea.t}</span>
      <svg viewBox="0 0 100 8" preserveAspectRatio="none" className="chalky" aria-hidden="true">
        <path d={idea.d} />
      </svg>
    </button>
  );
}
