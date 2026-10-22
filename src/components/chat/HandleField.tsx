"use client";
import { useEffect, useState, type KeyboardEventHandler } from "react";
import { TextInput } from "@/components/ui";
import { HANDLE_MAX, HANDLE_TAKEN, handleProblem, normalHandle } from "@/lib/handles";
import styles from "./HandleField.module.css";

// Typing a handle, with live availability: what is wrong with its form right
// away, then whether someone has it, asked once typing pauses. Used by the
// account menu and by the publish sheet.

export type HandleCheck = (handle: string, signal: AbortSignal) => Promise<{ available: boolean; error?: string }>;

export interface HandleStatus {
  // Whether it can be saved as typed: free, or already the user's own.
  ok: boolean;
  checking: boolean;
  message: string | null;
}

const WAIT_MS = 300;

export function useHandleStatus(value: string, current: string, check: HandleCheck): HandleStatus {
  const handle = normalHandle(value);
  const problem = handleProblem(handle);
  const mine = handle === current;
  const [answer, setAnswer] = useState<{ handle: string; available: boolean; error?: string } | null>(null);

  useEffect(() => {
    if (problem || mine) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      check(handle, controller.signal)
        .then((r) => setAnswer({ handle, ...r }))
        // Could not ask: saving still checks.
        .catch(() => !controller.signal.aborted && setAnswer({ handle, available: true, error: "unchecked" }));
    }, WAIT_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [handle, problem, mine, check]);

  if (problem) return { ok: false, checking: false, message: problem };
  if (mine) return { ok: true, checking: false, message: null };
  if (answer?.handle !== handle) return { ok: false, checking: true, message: "Checking..." };
  if (!answer.available) return { ok: false, checking: false, message: answer.error ?? HANDLE_TAKEN };
  return { ok: true, checking: false, message: answer.error === "unchecked" ? null : "Available" };
}

interface Props {
  id: string;
  value: string;
  status: HandleStatus;
  onChange: (value: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
  // A note under the field, by id.
  describedBy?: string;
}

export function HandleInput({ id, value, status, onChange, disabled, autoFocus, onKeyDown, describedBy }: Props) {
  const statusId = `${id}-status`;
  const state = status.checking ? "checking" : status.ok ? "ok" : "bad";
  return (
    <div className={styles.field}>
      <div className={styles.box}>
        <span className={styles.at} aria-hidden="true">
          @
        </span>
        <TextInput
          id={id}
          className={styles.input}
          value={value}
          maxLength={HANDLE_MAX + 1}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={disabled}
          autoFocus={autoFocus}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          aria-invalid={state === "bad"}
          aria-describedby={[statusId, describedBy].filter(Boolean).join(" ")}
        />
      </div>
      <p id={statusId} className={styles.status} data-state={state} aria-live="polite">
        {status.message}
      </p>
    </div>
  );
}
