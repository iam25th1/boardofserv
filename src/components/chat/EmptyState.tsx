"use client";
import { useLayoutEffect, useRef } from "react";
import { animate, createScope, createTimeline, stagger, svg, utils } from "animejs";
import { REDUCED_MOTION, ease } from "@/lib/motion";
import styles from "./EmptyState.module.css";

// The first screen. A big question, a handwritten nudge with a chalk arrow,
// and three examples. Tapping an example sends it as a real message.

const IDEAS = [
  {
    k: "watch",
    t: "Tell me when ETH drops below $2,000",
    send: "Tell me when ETH drops below $2,000",
    d: "M0 5 C 25 2, 60 8, 100 4",
  },
  {
    k: "every morning",
    t: "Send me the three biggest AI stories",
    send: "Send me the three biggest AI stories every morning",
    d: "M0 4 C 30 7, 55 1, 100 5",
  },
  {
    k: "reply for me",
    t: "A Telegram bot that answers questions about my shop",
    send: "A Telegram bot that answers questions about my shop",
    d: "M0 5 C 20 3, 70 7, 100 3",
  },
];

export function EmptyState({ onPick, disabled }: { onPick: (text: string) => void; disabled?: boolean }) {
  const root = useRef<HTMLDivElement>(null);

  // Layout effect: the hidden starting state is applied before first paint.
  useLayoutEffect(() => {
    const scope = createScope({ root, mediaQueries: { reduce: REDUCED_MOTION } }).add((self) => {
      const reduce = Boolean(self?.matches.reduce);
      const arrow = svg.createDrawable(".arrow path", 0, reduce ? 1 : 0);
      const underlines = [...(root.current?.querySelectorAll<HTMLButtonElement>("[data-idea]") ?? [])].map((button) => ({
        button,
        line: svg.createDrawable(button.querySelector("path")!, 0, 0),
      }));

      // Arrival: the question rises, the arrow is drawn, the note and the
      // line follow, then the examples arrive one after another.
      if (!reduce) {
        utils.set(["h1", "[data-note]", "[data-line]", "[data-idea]"], { opacity: 0 });
        createTimeline({ defaults: { ease: ease.arrive } })
          .add("h1", { opacity: { from: 0, to: 1 }, translateY: { from: 10, to: 0 }, duration: 420 })
          .add(arrow, { draw: ["0 0", "0 1"], duration: 600, ease: ease.draw }, "-=180")
          .add("[data-note]", { opacity: { from: 0, to: 1 }, duration: 360 }, "<<+=120")
          .add("[data-line]", { opacity: { from: 0, to: 1 }, translateY: { from: 6, to: 0 }, duration: 360 }, "-=240")
          .add(
            "[data-idea]",
            { opacity: { from: 0, to: 1 }, translateY: { from: 8, to: 0 }, duration: 380, delay: stagger(70) },
            "-=200",
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
        <h1>What should your agent do for you?</h1>
        <div className={styles.scrawl} aria-hidden="true">
          <svg viewBox="0 0 70 34" className="arrow chalky">
            <path d="M4 6c14 22 34 26 58 18M54 16l8 8-11 3" />
          </svg>
          <span data-note>just say it plainly</span>
        </div>
        <p data-line>I&apos;ll ask what I need, sketch the agent as we talk, then run it for you. No code and no setup screens.</p>
        <div className={styles.ideas}>
          {IDEAS.map((idea) => (
            <button
              key={idea.k}
              type="button"
              className={styles.idea}
              data-idea
              disabled={disabled}
              onClick={() => onPick(idea.send)}
            >
              <span className={styles.k}>{idea.k}</span>
              <span className={styles.t}>{idea.t}</span>
              <svg viewBox="0 0 100 8" preserveAspectRatio="none" className="chalky" aria-hidden="true">
                <path d={idea.d} />
              </svg>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
