"use client";
import { useId, useState } from "react";
import { Button, Dialog, Textarea } from "@/components/ui";
import type { MakerDashboardDTO } from "@/lib/types";
import styles from "./KillSwitch.module.css";

// The maker's kill switch: stop the agent everywhere at once, with a note
// for renters, and start it again. Stopping says exactly what happens
// before it does it.

export function KillSwitch({ d, kill }: { d: MakerDashboardDTO; kill: (action: "stop" | "start", note?: string) => Promise<unknown> }) {
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const noteId = useId();
  const renting = d.renters.filter((r) => r.status !== "ended").length;

  const act = async (action: "stop" | "start") => {
    setBusy(true);
    setSaid(null);
    try {
      await kill(action, action === "stop" ? note.trim() || undefined : undefined);
      setAsking(false);
      setNote("");
    } catch (err) {
      setSaid(err instanceof Error ? err.message : "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  };

  if (d.stopped) {
    return (
      <section className={styles.panel} data-stopped="true" aria-labelledby="kill-h">
        <h2 id="kill-h">Stopped everywhere</h2>
        <p>
          Since {new Date(d.stopped.at).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}. Every copy is paused, renewals wait and nobody new can rent it.
        </p>
        {d.stopped.note && <p className={styles.note}>You told renters: &ldquo;{d.stopped.note}&rdquo;</p>}
        <Button onClick={() => void act("start")} disabled={busy}>
          {busy ? "Starting..." : "Start it again everywhere"}
        </Button>
        <p className={styles.quiet}>Starting it again resumes every copy it paused and adds the time it was stopped to each renter&apos;s paid week.</p>
        {said && (
          <p className={styles.said} role="alert">
            {said}
          </p>
        )}
      </section>
    );
  }

  return (
    <section className={styles.panel} aria-labelledby="kill-h">
      <h2 id="kill-h">Stop it everywhere</h2>
      <p className={styles.quiet}>If it is doing something wrong, stop every copy at once while you fix it.</p>
      <Button variant="ghost" onClick={() => setAsking(true)} disabled={busy || Boolean(d.frozen)}>
        Stop it everywhere
      </Button>
      {d.frozen && <p className={styles.note}>boardofserv froze it: {d.frozen}</p>}
      <Dialog
        open={asking}
        onClose={() => !busy && setAsking(false)}
        title={`Stop ${d.name} everywhere?`}
        actions={
          <>
            <Button variant="ghost" onClick={() => setAsking(false)} disabled={busy}>
              Keep it running
            </Button>
            <Button onClick={() => void act("stop")} disabled={busy}>
              {busy ? "Stopping..." : "Stop it everywhere"}
            </Button>
          </>
        }
      >
        <ul className={styles.terms}>
          <li>
            {renting === 1 ? "The 1 copy rented now pauses" : `All ${renting} copies rented now pause`}, and yours too. A step running now finishes; nothing after it runs.
          </li>
          <li>Each renter is told, in the app and on Telegram.</li>
          <li>Renewals wait and nobody new can rent it, until you start it again.</li>
        </ul>
        <label htmlFor={noteId} className={styles.label}>
          A note for renters (optional)
        </label>
        <Textarea id={noteId} rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What happened, and when you expect it back" />
        {said && (
          <p className={styles.said} role="alert">
            {said}
          </p>
        )}
      </Dialog>
    </section>
  );
}
