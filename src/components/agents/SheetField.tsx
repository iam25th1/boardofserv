"use client";
import { useLayoutEffect, useRef, useState } from "react";
import { animate } from "animejs";
import { Button, TextInput } from "@/components/ui";
import { parseSheetLink, type SheetAnswer } from "@/lib/google/sheetLink";
import { dustIn, prefersReducedMotion } from "@/lib/motion";
import styles from "./InstallForm.module.css";

// A sheet setting, for real: the owner pastes a Google Sheet's link,
// boardofserv opens it on their own Google access (so it is one they may
// open), and they pick the tab from its tabs. The tab the link points at is
// picked first. The tabs dust in once found; with reduced motion they are
// simply there.

export interface SheetInfo {
  title: string;
  tabs: { id: number; title: string }[];
}

export function SheetField({
  id,
  value,
  onChange,
  inspect,
  invalid,
  describedBy,
}: {
  id: string;
  value: SheetAnswer | null;
  onChange: (v: SheetAnswer | null) => void;
  inspect: (url: string) => Promise<SheetInfo>;
  invalid?: boolean;
  describedBy?: string;
}) {
  const [url, setUrl] = useState(value?.url ?? "");
  const [info, setInfo] = useState<SheetInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const tabsRef = useRef<HTMLLabelElement>(null);

  useLayoutEffect(() => {
    if (!info || !tabsRef.current || prefersReducedMotion()) return;
    animate(tabsRef.current, { ...dustIn, duration: 320 });
  }, [info]);

  const open = async () => {
    const link = parseSheetLink(url);
    if (!link) {
      setSaid("Paste the link of a Google Sheet (docs.google.com/spreadsheets/...).");
      return;
    }
    setBusy(true);
    setSaid(null);
    try {
      const found = await inspect(url.trim());
      setInfo(found);
      const tab = found.tabs.find((t) => t.id === link.gid) ?? found.tabs[0];
      onChange(tab ? { url: url.trim(), tab: tab.title } : null);
      if (!found.tabs.length) setSaid("That sheet has no tabs to pick.");
    } catch (err) {
      setInfo(null);
      onChange(null);
      setSaid(err instanceof Error ? err.message : "It couldn't be opened. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.sheet}>
      <div className={styles.row}>
        <TextInput
          id={id}
          type="url"
          value={url}
          placeholder="https://docs.google.com/spreadsheets/d/..."
          aria-invalid={invalid}
          aria-describedby={describedBy}
          onChange={(e) => {
            setUrl(e.target.value);
            if (info) {
              setInfo(null);
              onChange(null);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void open();
            }
          }}
        />
        <Button type="button" variant="ghost" size="sm" onClick={() => void open()} disabled={busy || !url.trim()}>
          {busy ? "Opening..." : "Open it"}
        </Button>
      </div>
      {info && info.tabs.length > 0 && (
        <label className={styles.field} ref={tabsRef}>
          <span className={styles.help}>
            &ldquo;{info.title}&rdquo; opened. Which tab?
          </span>
          <select className={styles.select} value={value?.tab ?? ""} onChange={(e) => onChange({ url: url.trim(), tab: e.target.value })}>
            {info.tabs.map((t) => (
              <option key={t.id} value={t.title}>
                {t.title}
              </option>
            ))}
          </select>
        </label>
      )}
      {said && (
        <span className={styles.error} role="status">
          {said}
        </span>
      )}
    </div>
  );
}
