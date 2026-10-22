"use client";
import { useEffect, useId, useRef, useState } from "react";
import type { AccountDTO } from "@/lib/types";
import { Button } from "@/components/ui";
import { SignOutIcon } from "@/components/icons";
import { animateDrop, animateStateChange } from "@/lib/motion";
import { normalHandle } from "@/lib/handles";
import { HandleInput, useHandleStatus, type HandleCheck } from "./HandleField";
import styles from "./AccountMenu.module.css";

interface Props {
  account: AccountDTO | null;
  linking: boolean;
  onLink: () => void;
  onSignOut: () => void;
  onOpenShortcuts?: () => void;
  // Without these the handle shows but can't be changed.
  checkHandle?: HandleCheck;
  onSaveHandle?: (handle: string) => Promise<void>;
  startOpen?: boolean;
}

type CreditState = "ok" | "low" | "unknown" | "unlinked";

const CREDIT_TEXT: Record<CreditState, string> = {
  ok: "Credit is running",
  low: "Needs topping up",
  unknown: "Credit unknown",
  unlinked: "OpenServ not linked",
};

// The account menu at the right of the top bar. The avatar ring follows the
// agents popover's language: a solid ring when all is well, a dashed one when
// something is waiting on you (credit low, or OpenServ not linked yet).
export function AccountMenu({ account, linking, onLink, onSignOut, onOpenShortcuts, checkHandle, onSaveHandle, startOpen }: Props) {
  const [open, setOpen] = useState(Boolean(startOpen));
  const panel = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  const credit: CreditState | null = account ? (account.linked ? account.balance : "unlinked") : null;
  const needsYou = credit === "low" || credit === "unlinked";

  useEffect(() => {
    if (open && panel.current) animateDrop(panel.current);
  }, [open]);

  // A quiet cue on the avatar when the credit state changes under the user,
  // for example after a reply spends the last of it.
  const lastCredit = useRef(credit);
  useEffect(() => {
    if (lastCredit.current && credit && lastCredit.current !== credit && trigger.current) animateStateChange(trigger.current);
    lastCredit.current = credit;
  }, [credit]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const email = account?.email ?? "Signed in";
  const initial = (account?.email ?? "b").charAt(0).toUpperCase();

  return (
    <div className={styles.wrap} ref={wrap}>
      <button
        ref={trigger}
        type="button"
        className={styles.trigger}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Account, ${email}${credit ? `. ${CREDIT_TEXT[credit]}` : ""}`}
        data-needs-you={needsYou ? "true" : "false"}
      >
        <span className={styles.avatar} aria-hidden="true">
          {initial}
        </span>
      </button>

      {open && (
        <div className={styles.panel} ref={panel} id={panelId}>
          <div className={styles.section}>
            <p className={styles.label}>Signed in as</p>
            <p className={styles.value}>{email}</p>
          </div>

          {account && <HandleSection handle={account.handle} chosen={account.handleChosen} check={checkHandle} onSave={onSaveHandle} />}

          <div className={styles.section}>
            <p className={styles.label}>OpenServ account</p>
            {account?.linked ? (
              <>
                <p className={styles.value}>Linked{account.openservUserId ? ` (${account.openservUserId})` : ""}</p>
                <div className={styles.creditRow}>
                  <span className={styles.chip} data-state={account.balance}>
                    <i className={styles.ring} aria-hidden="true" />
                    {CREDIT_TEXT[account.balance]}
                  </span>
                  {account.balance === "low" && (
                    <a className={styles.topup} href="https://platform.openserv.ai/credits" target="_blank" rel="noopener noreferrer">
                      Top up
                    </a>
                  )}
                </div>
              </>
            ) : (
              <Button size="sm" onClick={onLink} disabled={linking} fullWidth>
                {linking ? "Linking..." : "Link your OpenServ account"}
              </Button>
            )}
          </div>

          <div className={styles.rowActions}>
            {onOpenShortcuts && (
              <button
                type="button"
                className={styles.action}
                onClick={() => {
                  setOpen(false);
                  // Focus returns here when the dialog closes.
                  trigger.current?.focus();
                  onOpenShortcuts();
                }}
              >
                <span className={styles.kbd} aria-hidden="true">
                  ?
                </span>
                Keyboard shortcuts
              </button>
            )}
            <button type="button" className={styles.action} onClick={onSignOut}>
              <SignOutIcon /> Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// "Your handle": the public name, edited in place with live availability.
// Escape or Cancel puts it back; Enter or Save keeps it.
function HandleSection({
  handle,
  chosen,
  check,
  onSave,
}: {
  handle: string;
  chosen: boolean;
  check?: HandleCheck;
  onSave?: (handle: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const labelId = useId();
  const inputId = useId();
  const changeRef = useRef<HTMLButtonElement>(null);

  return (
    <div className={styles.section}>
      <label className={styles.label} id={labelId} htmlFor={editing ? inputId : undefined}>
        Your handle
      </label>
      {editing && check && onSave ? (
        <HandleEditor
          inputId={inputId}
          handle={handle}
          check={check}
          onSave={onSave}
          onDone={() => {
            setEditing(false);
            requestAnimationFrame(() => changeRef.current?.focus());
          }}
        />
      ) : (
        <div className={styles.handleRow}>
          <p className={styles.value}>@{handle}</p>
          {!chosen && <span className={styles.random}>picked at random</span>}
          {check && onSave && (
            <button ref={changeRef} type="button" className={styles.change} onClick={() => setEditing(true)} aria-describedby={labelId}>
              Change
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function HandleEditor({
  inputId,
  handle,
  check,
  onSave,
  onDone,
}: {
  inputId: string;
  handle: string;
  check: HandleCheck;
  onSave: (handle: string) => Promise<void>;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState(handle);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = useHandleStatus(draft, handle, check);

  const save = async () => {
    if (!status.ok || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(normalHandle(draft));
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "It could not be saved. Try again.");
      setSaving(false);
    }
  };

  return (
    <form
      className={styles.handleEdit}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <HandleInput
        id={inputId}
        value={draft}
        status={error ? { ok: false, checking: false, message: error } : status}
        onChange={(v) => {
          setDraft(v);
          setError(null);
        }}
        disabled={saving}
        autoFocus
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            // Leaves the menu open.
            e.preventDefault();
            onDone();
          }
        }}
      />
      <div className={styles.handleActions}>
        <Button size="sm" variant="ghost" type="button" onClick={onDone} disabled={saving}>
          Cancel
        </Button>
        <Button size="sm" type="submit" disabled={!status.ok || saving}>
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>
    </form>
  );
}
