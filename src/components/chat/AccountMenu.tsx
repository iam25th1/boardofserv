"use client";
import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import type { AccountDTO } from "@/lib/types";
import { Button } from "@/components/ui";
import { SignOutIcon } from "@/components/icons";
import { animateDrop, animateStateChange } from "@/lib/motion";
import { normalHandle } from "@/lib/handles";
import { HandleInput, useHandleStatus, type HandleCheck } from "./HandleField";
import styles from "./AccountMenu.module.css";

interface Props {
  account: AccountDTO | null;
  onSignOut: () => void;
  onOpenShortcuts?: () => void;
  // Without these the handle shows but can't be changed.
  checkHandle?: HandleCheck;
  onSaveHandle?: (handle: string) => Promise<void>;
  // Without these the SERV key shows but can't be changed.
  onSaveServKey?: (key: string) => Promise<void>;
  onRemoveServKey?: () => Promise<void>;
  startOpen?: boolean;
}

type CreditState = "ok" | "low" | "unknown";

const CREDIT_TEXT: Record<CreditState, string> = {
  ok: "Credit is running",
  low: "Needs topping up",
  unknown: "Credit unknown",
};

// The account menu at the right of the top bar: the account's initial in a
// ring and its @handle beside it. The ring follows the agents popover's
// language: solid when all is well, dashed when something is waiting on you
// (a linked OpenServ account low on credit).
export function AccountMenu({ account, onSignOut, onOpenShortcuts, checkHandle, onSaveHandle, onSaveServKey, onRemoveServKey, startOpen }: Props) {
  const [open, setOpen] = useState(Boolean(startOpen));
  const panel = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  const credit: CreditState | null = account?.linked ? account.balance : null;
  const needsYou = credit === "low";

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
  const handle = account?.handle ?? null;
  const initial = (handle ?? account?.email ?? "b").charAt(0).toUpperCase();

  return (
    <div className={styles.wrap} ref={wrap}>
      <button
        ref={trigger}
        type="button"
        className={styles.trigger}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Account${handle ? `, @${handle}` : ""}, ${email}${credit ? `. ${CREDIT_TEXT[credit]}` : ""}`}
        data-needs-you={needsYou ? "true" : "false"}
      >
        <span className={styles.avatar} aria-hidden="true">
          {initial}
        </span>
        {handle && (
          <span className={styles.handle} aria-hidden="true">
            @{handle}
          </span>
        )}
      </button>

      {open && (
        <div className={styles.panel} ref={panel} id={panelId}>
          <div className={styles.section}>
            <p className={styles.label}>Signed in as</p>
            <p className={styles.value}>{email}</p>
          </div>

          {account && <HandleSection handle={account.handle} chosen={account.handleChosen} check={checkHandle} onSave={onSaveHandle} />}

          {account && <ServKeySection servKey={account.servKey ?? null} onSave={onSaveServKey} onRemove={onRemoveServKey} />}

          {/* An account linked before the SERV key replaced linking still shows. */}
          {account?.linked && (
            <div className={styles.section}>
              <p className={styles.label}>OpenServ account</p>
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
            </div>
          )}

          <div className={styles.section}>
            <p className={styles.label}>Wallet and agents</p>
            <div className={styles.links}>
              <Link className={styles.topup} href="/app/wallet">
                Balance, top up and earnings
              </Link>
              <Link className={styles.topup} href="/app/agents">
                Agents you&apos;re building
              </Link>
              <Link className={styles.topup} href="/app/connections">
                Connections: Telegram and Google
              </Link>
              {account?.admin && (
                <Link className={styles.topup} href="/app/admin">
                  Admin
                </Link>
              )}
            </div>
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

// "Your SERV key": use your own key, shown only by its last four characters,
// or remove it. The key typed in stays in this form until it is saved, then
// leaves the browser for good: nothing sends it back.
function ServKeySection({
  servKey,
  onSave,
  onRemove,
}: {
  servKey: { last4: string } | null;
  onSave?: (key: string) => Promise<void>;
  onRemove?: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const noteId = useId();

  const save = async () => {
    if (!onSave || !draft.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(draft.trim());
      setDraft("");
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "It could not be saved. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!onRemove || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onRemove();
    } catch (err) {
      setError(err instanceof Error ? err.message : "It could not be removed. Try again.");
    } finally {
      setBusy(false);
    }
  };

  if (servKey) {
    return (
      <div className={styles.section}>
        <p className={styles.label}>Your SERV key</p>
        <div className={styles.handleRow}>
          <p className={styles.value}>
            Ending <span className={styles.mono}>{servKey.last4}</span>
          </p>
          {onRemove && (
            <button type="button" className={styles.change} onClick={() => void remove()} disabled={busy}>
              {busy ? "Removing..." : "Remove"}
            </button>
          )}
        </div>
        <p className={styles.hint}>Your chats and helper uses run on it, on your own SERV credit, with no daily limit.</p>
        {error && (
          <p className={styles.keyError} role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }

  if (!editing || !onSave) {
    return (
      <div className={styles.section}>
        <Button size="sm" onClick={() => setEditing(true)} disabled={!onSave} fullWidth>
          Use your own SERV key
        </Button>
      </div>
    );
  }

  return (
    <form
      className={styles.section}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label className={styles.label} htmlFor={inputId}>
        Your SERV key
      </label>
      <input
        id={inputId}
        className={styles.keyInput}
        type="password"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            setEditing(false);
            setDraft("");
          }
        }}
        autoComplete="off"
        spellCheck={false}
        disabled={busy}
        aria-describedby={noteId}
        autoFocus
      />
      <p className={styles.hint} id={noteId}>
        Checked with one tiny call on its own credit, then kept encrypted. Only its last four characters are ever shown.
      </p>
      {error && (
        <p className={styles.keyError} role="alert">
          {error}
        </p>
      )}
      <div className={`${styles.handleActions} ${styles.keyActions}`}>
        <Button
          size="sm"
          variant="ghost"
          type="button"
          onClick={() => {
            setEditing(false);
            setDraft("");
            setError(null);
          }}
          disabled={busy}
        >
          Cancel
        </Button>
        <Button size="sm" type="submit" disabled={!draft.trim() || busy}>
          {busy ? "Checking..." : "Save"}
        </Button>
      </div>
    </form>
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
