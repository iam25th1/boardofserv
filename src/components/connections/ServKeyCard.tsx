"use client";
import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { Button, TextInput } from "@/components/ui";
import styles from "./ConnectionsView.module.css";

// The owner's own SERV key, on Connections (the account menu has it too):
// with it, their chats, helpers and agents run on their own SERV credit,
// and a free agent's weekly model allowance no longer caps it. The key
// typed in leaves the browser once saved; only its last four characters
// ever come back.
export const SERV_KEY_ANCHOR = "serv-key";

export function ServKeyCard({ servKey, onSave, onRemove }: { servKey: { last4: string } | null; onSave: (key: string) => Promise<void>; onRemove: () => Promise<void> }) {
  const id = useId();
  const ref = useRef<HTMLElement>(null);
  // Sent here from a budget card (#serv-key): it comes into view once the
  // account has loaded, which is after the browser looked for it.
  useEffect(() => {
    if (window.location.hash === `#${SERV_KEY_ANCHOR}`) ref.current?.scrollIntoView({ block: "start" });
  }, []);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const act = async (f: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setSaid(null);
    try {
      await f();
      setDraft("");
    } catch (err) {
      setSaid(err instanceof Error ? err.message : "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section ref={ref} className={styles.card} id={SERV_KEY_ANCHOR} data-connected={servKey ? "true" : "false"} aria-labelledby={`${id}-h`}>
      <div className={styles.head}>
        <h2 id={`${id}-h`} className={styles.name}>
          Your SERV key
        </h2>
        <span className={styles.state}>{servKey ? `in use, ending ${servKey.last4}` : "not added"}</span>
      </div>
      <p className={styles.for}>
        {servKey
          ? "Your chats, helpers and agents run on your own SERV credit, so no free weekly allowance caps your agents: each one goes by the weekly budget you set on its page."
          : "Without it, boardofserv pays for a free agent's model calls, up to a small allowance each week, and the agent pauses when that runs out. With your own key, its calls go on your SERV credit and only the weekly budget you set caps it."}
      </p>
      {servKey ? (
        <div className={styles.actions}>
          <Button size="sm" variant="ghost" onClick={() => void act(onRemove)} disabled={busy}>
            {busy ? "Removing..." : "Remove it"}
          </Button>
        </div>
      ) : (
        <form
          className={styles.details}
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) void act(() => onSave(draft.trim()));
          }}
        >
          <div className={styles.field}>
            <label htmlFor={`${id}-key`} className={styles.quiet}>
              Paste your SERV key
            </label>
            <TextInput id={`${id}-key`} type="password" autoComplete="off" spellCheck={false} value={draft} onChange={(e) => setDraft(e.target.value)} disabled={busy} />
          </div>
          <p className={styles.quiet}>
            It is checked with one tiny call on its own credit, kept encrypted, and only its last four characters are ever shown. More on <Link href="/privacy">Your data</Link>.
          </p>
          <div className={styles.actions}>
            <Button size="sm" type="submit" disabled={busy || !draft.trim()}>
              {busy ? "Checking it..." : "Use my key"}
            </Button>
          </div>
        </form>
      )}
      {said && (
        <p className={styles.said} role="alert">
          {said}
        </p>
      )}
    </section>
  );
}
