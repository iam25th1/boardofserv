"use client";
import { useEffect, useRef } from "react";
import { Wordmark } from "./Wordmark";
import { animateEnter } from "@/lib/motion";
import styles from "./EmptyState.module.css";

const EXAMPLES = [
  "Tell my Telegram group when ETH drops 5 percent",
  "Email me a summary of my Gmail every morning at 8",
  "Post my new blog articles to my X account",
  "Watch a wallet address and alert me on large transfers",
  "Draft a reply when someone fills in my Notion form",
];

export function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) animateEnter(ref.current, 12);
  }, []);
  return (
    <div className={styles.wrap} ref={ref}>
      <div className={styles.inner}>
        <p className={styles.kicker}>
          <Wordmark />
        </p>
        <h1 className={styles.welcome}>What should your agent do?</h1>
        <p className={styles.sub}>
          Describe it the way you would to a colleague. Start from scratch or pick one of these.
        </p>
        <ul className={styles.examples}>
          {EXAMPLES.map((ex) => (
            <li key={ex}>
              <button type="button" className={styles.example} onClick={() => onPick(ex)}>
                {ex}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
