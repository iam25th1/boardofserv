"use client";
import { useEffect, useId, useState } from "react";
import { Button, Dialog, TextInput } from "@/components/ui";
import styles from "./PublishSheet.module.css";

// The confirm sheet before an answer helper goes on the board: its public
// name, a one-line description and a "what to type" hint the maker can edit,
// and a plain note that their instructions stay private.

interface Props {
  open: boolean;
  name: string;
  description: string;
  inputHint: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onPublish: (edits: { description: string; inputHint: string }) => void;
}

export function PublishSheet({ open, name, description, inputHint, busy, error, onCancel, onPublish }: Props) {
  const [line, setLine] = useState(description);
  const [hint, setHint] = useState(inputHint);
  const lineId = useId();
  const hintId = useId();

  // Each time it opens, it starts from the sketch.
  useEffect(() => {
    if (!open) return;
    setLine(description);
    setHint(inputHint);
  }, [open, description, inputHint]);

  const ready = line.trim() && hint.trim() && !busy;

  return (
    <Dialog
      open={open}
      onClose={() => !busy && onCancel()}
      title="Put it on the board"
      actions={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => onPublish({ description: line.trim(), inputHint: hint.trim() })} disabled={!ready}>
            {busy ? "Publishing..." : "Publish"}
          </Button>
        </>
      }
    >
      <div className={styles.sheet}>
        <div className={styles.name}>
          <strong>{name}</strong>
          <span className={styles.note}>what everyone sees</span>
        </div>
        <div className={styles.field}>
          <label htmlFor={lineId}>One line about it</label>
          <TextInput id={lineId} value={line} maxLength={140} onChange={(e) => setLine(e.target.value)} disabled={busy} />
        </div>
        <div className={styles.field}>
          <label htmlFor={hintId}>What to type</label>
          <TextInput
            id={hintId}
            value={hint}
            maxLength={80}
            onChange={(e) => setHint(e.target.value)}
            disabled={busy}
            aria-describedby={`${hintId}-note`}
          />
          <small id={`${hintId}-note`}>Shown in the box people type into.</small>
        </div>
        <p className={styles.private}>Your instructions stay private. People see the name, this line and the hint, never how it works.</p>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
