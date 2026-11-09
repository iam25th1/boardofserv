"use client";
import { useId, useState } from "react";
import Link from "next/link";
import { Button, Dialog, Textarea } from "@/components/ui";
import styles from "./ReportButton.module.css";

// Reporting an agent, a maker, a request or an offer: a quiet link that
// opens a short form (a reason from the list, and a note). It goes to the
// admins' queue.

export type ReportKind = "agent" | "maker" | "request" | "offer";
export type ReportSend = (body: { kind: ReportKind; targetId: string; reason: string; note: string }) => Promise<void>;

const REASONS = [
  { id: "scam", words: "A scam or fraud" },
  { id: "harmful", words: "Harmful or illegal" },
  { id: "personal_data", words: "Shares someone's personal data" },
  { id: "spam", words: "Spam" },
  { id: "misleading", words: "Misleading about what it does" },
  { id: "other", words: "Something else" },
] as const;

const WHAT: Record<ReportKind, string> = { agent: "this agent", maker: "its maker", request: "this request", offer: "this offer" };

export function ReportButton({ kind, targetId, send, signIn, label }: { kind: ReportKind; targetId: string; send?: ReportSend; signIn?: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string>("scam");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const noteId = useId();
  const name = useId();
  const text = label ?? `Report ${WHAT[kind]}`;
  if (!send) return signIn ? <Link className={styles.link} href={signIn}>{text}</Link> : null;
  const go = async () => {
    setBusy(true);
    setSaid(null);
    try {
      await send({ kind, targetId, reason, note: note.trim() });
      setSaid({ text: "Thanks. An admin will look at it." });
    } catch (err) {
      setSaid({ text: err instanceof Error ? err.message : "It couldn't be sent. Try again.", bad: true });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button type="button" className={styles.link} onClick={() => setOpen(true)}>
        {text}
      </button>
      <Dialog
        open={open}
        onClose={() => !busy && setOpen(false)}
        title={`Report ${WHAT[kind]}`}
        actions={
          said && !said.bad ? (
            <Button onClick={() => setOpen(false)}>Done</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button onClick={() => void go()} disabled={busy}>
                {busy ? "Sending..." : "Send the report"}
              </Button>
            </>
          )
        }
      >
        <fieldset className={styles.reasons}>
          <legend>What is wrong?</legend>
          {REASONS.map((r) => (
            <label key={r.id}>
              <input type="radio" name={name} value={r.id} checked={reason === r.id} onChange={() => setReason(r.id)} />
              {r.words}
            </label>
          ))}
        </fieldset>
        <label htmlFor={noteId} className={styles.label}>
          A note (optional)
        </label>
        <Textarea id={noteId} rows={3} maxLength={600} value={note} onChange={(e) => setNote(e.target.value)} />
        {said && (
          <p className={styles.said} role={said.bad ? "alert" : "status"}>
            {said.text}
          </p>
        )}
      </Dialog>
    </>
  );
}
