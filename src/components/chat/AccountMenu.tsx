"use client";
import { useEffect, useId, useRef, useState } from "react";
import type { AccountDTO } from "@/lib/types";
import { Button } from "@/components/ui";
import { SignOutIcon } from "@/components/icons";
import { animateDrop, animateStateChange } from "@/lib/motion";
import styles from "./AccountMenu.module.css";

interface Props {
  account: AccountDTO | null;
  linking: boolean;
  onLink: () => void;
  onSignOut: () => void;
  onOpenShortcuts?: () => void;
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
export function AccountMenu({ account, linking, onLink, onSignOut, onOpenShortcuts, startOpen }: Props) {
  const [open, setOpen] = useState(Boolean(startOpen));
  const panel = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const stateRef = useRef<HTMLSpanElement>(null);
  const panelId = useId();

  const credit: CreditState | null = account ? (account.linked ? account.balance : "unlinked") : null;
  const needsYou = credit === "low" || credit === "unlinked";

  useEffect(() => {
    if (open && panel.current) animateDrop(panel.current);
  }, [open]);

  // A quiet cue when the credit state changes under the user, for example
  // after a reply spends the last of it.
  const lastCredit = useRef(credit);
  useEffect(() => {
    if (lastCredit.current && credit && lastCredit.current !== credit && stateRef.current) animateStateChange(stateRef.current);
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

          <div className={styles.section}>
            <p className={styles.label}>OpenServ account</p>
            {account?.linked ? (
              <>
                <p className={styles.value}>Linked{account.openservUserId ? ` (${account.openservUserId})` : ""}</p>
                <div className={styles.creditRow}>
                  <span className={styles.chip} data-state={account.balance} ref={stateRef}>
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
