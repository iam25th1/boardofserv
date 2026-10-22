"use client";
import { useEffect, useId, useState } from "react";
import { Button, Dialog, TextInput } from "@/components/ui";
import { normalHandle } from "@/lib/handles";
import { HandleInput, useHandleStatus, type HandleCheck } from "./HandleField";
import styles from "./PublishSheet.module.css";

// The confirm sheet before an answer helper goes on the board: its public
// name, a one-line description and a "what to type" hint the maker can edit,
// and a plain note that their instructions stay private. While the maker's
// handle is still the random one they were given, the sheet asks them to
// keep it or choose their own: it is how the board names them.

export interface PublishEdits {
  description: string;
  inputHint: string;
  // Set when the sheet asked for the handle.
  handle?: string;
}

interface Props {
  open: boolean;
  name: string;
  description: string;
  inputHint: string;
  // The maker's handle, once the account has loaded.
  handle: { current: string; chosen: boolean } | null;
  checkHandle: HandleCheck;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onPublish: (edits: PublishEdits) => void;
}

export function PublishSheet({ open, name, description, inputHint, handle, checkHandle, busy, error, onCancel, onPublish }: Props) {
  const [line, setLine] = useState(description);
  const [hint, setHint] = useState(inputHint);
  const [draft, setDraft] = useState(handle?.current ?? "");
  // Decided as it opens, so saving the handle part way through publishing
  // doesn't pull the field away.
  const [askHandle, setAskHandle] = useState(false);
  const lineId = useId();
  const hintId = useId();
  const handleId = useId();
  const current = handle?.current ?? "";
  const status = useHandleStatus(draft, current, checkHandle);

  // Each time it opens, it starts from the sketch and the account.
  useEffect(() => {
    if (!open) return;
    setLine(description);
    setHint(inputHint);
    setDraft(current);
    setAskHandle(Boolean(handle && !handle.chosen));
    // Only on opening: the handle saved while publishing must not reset it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, description, inputHint]);

  const ready = line.trim() && hint.trim() && !busy && (!askHandle || status.ok);
  const by = askHandle ? normalHandle(draft) || current : current;

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
          <Button
            onClick={() => onPublish({ description: line.trim(), inputHint: hint.trim(), ...(askHandle && { handle: normalHandle(draft) }) })}
            disabled={!ready}
          >
            {busy ? "Publishing..." : "Publish"}
          </Button>
        </>
      }
    >
      <div className={styles.sheet}>
        <div className={styles.name}>
          <strong>{name}</strong>
          <span className={styles.note}>what everyone sees</span>
          {by && <span className={styles.by}>by @{by}</span>}
        </div>
        {askHandle && (
          <div className={styles.field}>
            <label htmlFor={handleId}>Your handle</label>
            <HandleInput
              id={handleId}
              value={draft}
              status={status}
              onChange={setDraft}
              disabled={busy}
              describedBy={`${handleId}-note`}
            />
            <small id={`${handleId}-note`}>We picked this one at random. Keep it or choose your own; the board shows it as the maker.</small>
          </div>
        )}
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
