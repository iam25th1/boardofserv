"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { animate } from "animejs";
import { Button } from "@/components/ui";
import { dustIn, prefersReducedMotion } from "@/lib/motion";
import styles from "./ConnectionsView.module.css";

// Linking Telegram: a one-time code to send the bot from the chat to link
// (or a link that opens Telegram with it ready). While the code is good,
// the page looks every few seconds, and the card turns linked as soon as
// the bot has the code. The code dusts in; with reduced motion it is
// simply there.

export interface LinkCode {
  code: string;
  link: string;
  bot: string;
  expiresAt: string;
}

const LOOK_MS = 3_000;

const clock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export function TelegramLink({ getCode, refresh }: { getCode: () => Promise<LinkCode>; refresh: () => Promise<void> }) {
  const [code, setCode] = useState<LinkCode | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const codeRef = useRef<HTMLParagraphElement>(null);
  const left = code ? new Date(code.expiresAt).getTime() - now : 0;
  const live = Boolean(code) && left > 0;

  useEffect(() => {
    if (!live) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const look = setInterval(() => void refresh(), LOOK_MS);
    return () => {
      clearInterval(tick);
      clearInterval(look);
    };
  }, [live, refresh]);

  useLayoutEffect(() => {
    if (!code || !codeRef.current || prefersReducedMotion()) return;
    animate(codeRef.current, { ...dustIn, duration: 420 });
  }, [code]);

  const ask = async () => {
    setBusy(true);
    setSaid(null);
    try {
      setCode(await getCode());
      setNow(Date.now());
    } catch (err) {
      setSaid(err instanceof Error ? err.message : "No code came. Try again.");
    } finally {
      setBusy(false);
    }
  };

  if (!live) {
    return (
      <div className={styles.details}>
        {code && <p className={styles.quiet}>That code ran out. Get a new one.</p>}
        <div className={styles.actions}>
          <Button size="sm" onClick={() => void ask()} disabled={busy}>
            {busy ? "Getting a code..." : "Link Telegram"}
          </Button>
        </div>
        {said && (
          <p className={styles.said} role="status">
            {said}
          </p>
        )}
      </div>
    );
  }
  return (
    <div className={styles.details}>
      <p>
        From the Telegram chat you want linked, send{" "}
        <a href={code!.link} target="_blank" rel="noopener noreferrer">
          @{code!.bot}
        </a>{" "}
        this:
      </p>
      <p className={styles.code} ref={codeRef} aria-live="polite">
        /start {code!.code}
      </p>
      <div className={styles.actions}>
        <a className={styles.open} href={code!.link} target="_blank" rel="noopener noreferrer">
          Open Telegram with it
        </a>
      </div>
      <p className={styles.quiet}>It works once, for {clock(left)} more. This page turns linked as soon as the bot has it.</p>
    </div>
  );
}
