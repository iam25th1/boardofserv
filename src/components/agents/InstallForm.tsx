"use client";
import { useMemo, useState } from "react";
import type { AgentDefinition } from "@/lib/agents/definition";
import { checkAnswers, DEFAULT_DAILY_SPEND_USD, DEFAULT_MIN_GAP_MINUTES, MAX_DAILY_SPEND_USD, type InstallAnswers } from "@/lib/agents/settingsForm";
import { Button, TextInput } from "@/components/ui";
import { isSheetAnswer } from "@/lib/google/sheetLink";
import { SheetField, type SheetInfo } from "./SheetField";
import styles from "./InstallForm.module.css";

// The form an owner fills in to run an agent for real: a field per settings
// question, typed by it, the rules with the maker's defaults, when it runs
// (for a scheduled agent) in the owner's time zone, and its limits. The
// answers are checked here as on the server, which has the last word.

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function zones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
}

const asText = (v: unknown): string => (v === undefined || v === null ? "" : Array.isArray(v) ? v.join(", ") : String(v));

export function InstallForm({
  definition: d,
  defaults,
  onInstall,
  onCancel,
  inspectSheet,
}: {
  definition: AgentDefinition;
  // Answers to start from: the test bench's sample settings.
  defaults: Record<string, unknown>;
  onInstall: (answers: InstallAnswers) => Promise<void>;
  onCancel?: () => void;
  // Opens a Google Sheet's link on the owner's Google access: its tabs.
  inspectSheet: (url: string) => Promise<SheetInfo>;
}) {
  const schedule = d.triggers.find((t) => t.kind === "schedule");
  const [settings, setSettings] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(d.settings.map((s) => [s.key, s.type === "boolean" ? Boolean(defaults[s.key]) : s.type === "sheet" ? (isSheetAnswer(defaults[s.key]) ? defaults[s.key] : null) : asText(defaults[s.key])])),
  );
  const [rules, setRules] = useState<Record<string, string>>(() => Object.fromEntries(d.rules.map((r) => [r.key, r.value])));
  const [timezone, setTimezone] = useState(browserZone);
  const [at, setAt] = useState(schedule?.kind === "schedule" ? (schedule.at ?? "") : "");
  const [day, setDay] = useState(1);
  const [gap, setGap] = useState(String(DEFAULT_MIN_GAP_MINUTES));
  const [spend, setSpend] = useState(String(DEFAULT_DAILY_SPEND_USD));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const allZones = useMemo(zones, []);

  const answers = (): InstallAnswers => ({
    settings,
    rules,
    timezone: timezone.trim(),
    schedule: schedule?.kind === "schedule" ? { at: at || null, day: schedule.every === "week" ? day : null } : null,
    minGapMinutes: Number(gap),
    dailySpendUsd: Number(spend),
  });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const a = answers();
    const checked = checkAnswers(d, a);
    if (!checked.ok) {
      setErrors(checked.errors);
      setSaid("Some answers need another look.");
      return;
    }
    setErrors({});
    setSaid(null);
    setBusy(true);
    try {
      await onInstall(a);
    } catch (err) {
      const fieldErrors = (err as { errors?: Record<string, string> }).errors;
      if (fieldErrors) setErrors(fieldErrors);
      setSaid(err instanceof Error ? err.message : "It could not start. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const err = (key: string) =>
    errors[key] ? (
      <span className={styles.error} id={`err-${key}`}>
        {errors[key]}
      </span>
    ) : null;

  return (
    <form className={styles.form} onSubmit={(e) => void submit(e)} noValidate>
      {d.settings.length > 0 && (
        <fieldset className={styles.group}>
          <legend>Its settings</legend>
          {d.settings.map((s) =>
            s.type === "sheet" ? (
              // Its own controls (a link, a button, a tab to pick): not one label.
              <div key={s.key} className={styles.field}>
                <label className={styles.label} htmlFor={`setting-${s.key}`}>
                  {s.label}
                </label>
                <SheetField
                  id={`setting-${s.key}`}
                  value={isSheetAnswer(settings[s.key]) ? (settings[s.key] as { url: string; tab: string }) : null}
                  onChange={(v) => setSettings((now) => ({ ...now, [s.key]: v }))}
                  inspect={inspectSheet}
                  invalid={Boolean(errors[s.key])}
                  describedBy={errors[s.key] ? `err-${s.key}` : undefined}
                />
                <span className={styles.help}>{s.help}</span>
                {err(s.key)}
              </div>
            ) : (
              <label key={s.key} className={styles.field}>
                <span className={styles.label}>{s.label}</span>
                {s.type === "boolean" ? (
                  <input type="checkbox" checked={Boolean(settings[s.key])} onChange={(e) => setSettings({ ...settings, [s.key]: e.target.checked })} />
                ) : s.type === "choice" ? (
                  <select className={styles.select} value={asText(settings[s.key])} onChange={(e) => setSettings({ ...settings, [s.key]: e.target.value })}>
                    <option value="">Pick one</option>
                    {s.choices.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                ) : (
                  <TextInput
                    type={s.type === "number" ? "number" : s.type === "url" ? "url" : "text"}
                    value={asText(settings[s.key])}
                    placeholder={s.type === "list" ? "separated by commas" : undefined}
                    aria-invalid={Boolean(errors[s.key])}
                    aria-describedby={errors[s.key] ? `err-${s.key}` : undefined}
                    onChange={(e) => setSettings({ ...settings, [s.key]: e.target.value })}
                  />
                )}
                <span className={styles.help}>{s.help}</span>
                {err(s.key)}
              </label>
            ),
          )}
        </fieldset>
      )}
      {d.rules.length > 0 && (
        <fieldset className={styles.group}>
          <legend>Its rules</legend>
          {d.rules.map((r) => (
            <label key={r.key} className={styles.field}>
              <span className={styles.label}>
                {r.label}
                {r.type === "usdc" ? " (USDC)" : ""}
              </span>
              <TextInput value={rules[r.key] ?? ""} aria-invalid={Boolean(errors[`rule:${r.key}`])} onChange={(e) => setRules({ ...rules, [r.key]: e.target.value })} />
              <span className={styles.help}>
                {r.help} The maker&apos;s default is {r.value || "empty"}.
              </span>
              {err(`rule:${r.key}`)}
            </label>
          ))}
        </fieldset>
      )}
      <fieldset className={styles.group}>
        <legend>When and how much</legend>
        <label className={styles.field}>
          <span className={styles.label}>Your time zone</span>
          <TextInput value={timezone} list="install-zones" onChange={(e) => setTimezone(e.target.value)} aria-invalid={Boolean(errors.timezone)} />
          <datalist id="install-zones">
            {allZones.map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
          {err("timezone")}
        </label>
        {schedule?.kind === "schedule" && schedule.every !== "hour" && (
          <div className={styles.row}>
            {schedule.every === "week" && (
              <label className={styles.field}>
                <span className={styles.label}>On</span>
                <select className={styles.select} value={day} onChange={(e) => setDay(Number(e.target.value))}>
                  {DAYS.map((name, i) => (
                    <option key={name} value={i}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className={styles.field}>
              <span className={styles.label}>At</span>
              <TextInput type="time" value={at} onChange={(e) => setAt(e.target.value)} aria-invalid={Boolean(errors.schedule)} />
            </label>
          </div>
        )}
        {err("schedule")}
        <div className={styles.row}>
          <label className={styles.field}>
            <span className={styles.label}>Model spend a day, at most (US dollars)</span>
            <TextInput type="number" min={0} max={MAX_DAILY_SPEND_USD} step={0.05} value={spend} onChange={(e) => setSpend(e.target.value)} aria-invalid={Boolean(errors.dailySpendUsd)} />
            {err("dailySpendUsd")}
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Minutes between jobs, at least</span>
            <TextInput type="number" min={0} max={1440} step={1} value={gap} onChange={(e) => setGap(e.target.value)} aria-invalid={Boolean(errors.minGapMinutes)} />
            {err("minGapMinutes")}
          </label>
        </div>
      </fieldset>
      {said && (
        <p className={styles.said} role="status">
          {said}
        </p>
      )}
      <div className={styles.actions}>
        {onCancel && (
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            Not now
          </Button>
        )}
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? "Starting..." : "Start it"}
        </Button>
      </div>
    </form>
  );
}
