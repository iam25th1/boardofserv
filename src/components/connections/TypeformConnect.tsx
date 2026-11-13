"use client";
import { useId, useState } from "react";
import Link from "next/link";
import { Button, TextInput } from "@/components/ui";
import styles from "./ConnectionsView.module.css";

// Connecting Typeform: the owner pastes a personal token from their own
// Typeform account. It is tried once with Typeform, kept encrypted, and
// never shown again; agents read only the forms their steps name, through
// it, and never see it.

export function TypeformConnect({ connect, onConnected }: { connect: (token: string) => Promise<{ label: string }>; onConnected?: () => void | Promise<void> }) {
  const id = useId();
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const go = async () => {
    if (!token.trim() || busy) return;
    setBusy(true);
    setSaid(null);
    try {
      await connect(token.trim());
      setToken("");
      await onConnected?.();
    } catch (err) {
      setSaid(err instanceof Error ? err.message : "It couldn't connect. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className={styles.details}
      onSubmit={(e) => {
        e.preventDefault();
        void go();
      }}
    >
      <p className={styles.quiet}>
        In Typeform, open your account&apos;s Personal tokens, generate a new token that can read forms and responses, and paste it here. It is kept
        encrypted and never shown again. Agents read only the forms you give them, and the answers a job reads go to SERV Reasoning only for that job.
        More on <Link href="/privacy">Your data</Link>.
      </p>
      <label htmlFor={id} className={styles.quiet}>
        Your Typeform personal token
      </label>
      <TextInput id={id} type="password" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} placeholder="tfp_..." />
      <div className={styles.actions}>
        <Button size="sm" type="submit" disabled={busy || !token.trim()}>
          {busy ? "Checking it with Typeform..." : "Connect Typeform"}
        </Button>
      </div>
      {said && (
        <p className={styles.said} role="status">
          {said}
        </p>
      )}
    </form>
  );
}
