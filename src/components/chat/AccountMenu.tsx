"use client";
import { useEffect, useRef, useState } from "react";
import type { AccountDTO } from "@/lib/types";
import { Button } from "@/components/ui";
import { SignOutIcon, SunIcon, MoonIcon } from "@/components/icons";
import { animatePop } from "@/lib/motion";
import styles from "./AccountMenu.module.css";

interface Props {
  account: AccountDTO | null;
  linking: boolean;
  onLink: () => void;
  onSignOut: () => void;
  startOpen?: boolean;
}

function useTheme(): [string, () => void] {
  const [theme, setTheme] = useState("light");
  useEffect(() => {
    setTheme(document.documentElement.getAttribute("data-theme") ?? "light");
  }, []);
  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("bos-theme", next);
    } catch {
      // persistence optional
    }
    setTheme(next);
  };
  return [theme, toggle];
}

export function AccountMenu({ account, linking, onLink, onSignOut, startOpen }: Props) {
  const [open, setOpen] = useState(Boolean(startOpen));
  const panel = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [theme, toggleTheme] = useTheme();

  useEffect(() => {
    if (open && panel.current) animatePop(panel.current);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const email = account?.email ?? "Signed in";
  const initial = (account?.email ?? "b").charAt(0).toUpperCase();

  return (
    <div className={styles.wrap} ref={wrap}>
      <button type="button" className={styles.trigger} onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="menu">
        <span className={styles.avatar} aria-hidden="true">{initial}</span>
        <span className={styles.triggerText}>
          <span className={styles.email}>{email}</span>
          {account && (
            <span className={styles.state} data-state={account.linked ? account.balance : "unlinked"}>
              {!account.linked ? "OpenServ not linked" : account.balance === "ok" ? "Credit is running" : account.balance === "low" ? "Needs topping up" : "Credit unknown"}
            </span>
          )}
        </span>
      </button>

      {open && (
        <div className={styles.panel} ref={panel} role="menu">
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
                  <span className={styles.chip} data-state={account.balance}>
                    {account.balance === "ok" ? "Credit is running" : account.balance === "low" ? "Needs topping up" : "Credit unknown"}
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
            <button type="button" className={styles.action} role="menuitem" onClick={toggleTheme}>
              {theme === "dark" ? <SunIcon /> : <MoonIcon />}
              {theme === "dark" ? "Light theme" : "Dark theme"}
            </button>
            <button type="button" className={styles.action} role="menuitem" onClick={onSignOut}>
              <SignOutIcon /> Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
