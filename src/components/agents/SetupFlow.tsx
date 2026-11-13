"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { animate, svg } from "animejs";
import { Button, TextInput } from "@/components/ui";
import { GoogleConnect } from "@/components/connections/GoogleConnect";
import { TypeformConnect } from "@/components/connections/TypeformConnect";
import { TelegramLink, type LinkCode } from "@/components/connections/TelegramLink";
import type { SetupShape } from "@/lib/agents/definition";
import { minIntervalMinutes } from "@/lib/agents/interval";
import { checkAnswers, DEFAULT_DAILY_SPEND_USD, DEFAULT_MIN_GAP_MINUTES, MAX_DAILY_SPEND_USD, type InstallAnswers } from "@/lib/agents/settingsForm";
import { isSheetAnswer } from "@/lib/google/sheetLink";
import { dustIn, ease, prefersReducedMotion } from "@/lib/motion";
import type { ConnectionDTO, InstallationDTO, JobDTO } from "@/lib/types";
import { JobTimeline } from "./JobTimeline";
import { SheetField, type SheetInfo } from "./SheetField";
import styles from "./SetupFlow.module.css";

// Setting an agent up to run for real, as a short guided flow:
//
// 1. its questions (the settings that aren't sheets),
// 2. Telegram linked, when it messages or asks its owner,
// 3. Google connected and each sheet picked, when it works on sheets,
// 4. its rules, when it runs and its limits,
// 5. a test run: set up but not live, it runs once by hand, for real, and
//    shows each step as it goes; then the owner makes it live.
//
// The answers are checked at each step as the server will check them. They
// are kept in this tab (sessionStorage) so the way to Google and back picks
// up where it was. The steps along the top draw their line as the owner
// moves on, and each step's panel dusts in; with reduced motion everything
// is simply there.

export interface SetupApi {
  connections: () => Promise<{ connections: ConnectionDTO[]; available: Record<"telegram" | "google", boolean> & { typeform?: boolean } }>;
  telegramCode: () => Promise<LinkCode>;
  googleStart: (returnTo: string) => Promise<{ url: string }>;
  // Connect Typeform with a pasted personal token (absent: not offered here).
  connectTypeform?: (token: string) => Promise<{ label: string }>;
  inspectSheet: (url: string) => Promise<SheetInfo>;
  // Installs it for a test run (not live).
  install: (answers: InstallAnswers) => Promise<InstallationDTO>;
  control: (installationId: string, action: "test" | "golive" | "stop") => Promise<InstallationDTO>;
  installation: (id: string) => Promise<InstallationDTO>;
  job: (id: string) => Promise<JobDTO>;
  answer: (approvalId: string, answer: string) => Promise<void>;
}

type StepKey = "settings" | "telegram" | "google" | "typeform" | "rules" | "test";
const STEP_TITLE: Record<StepKey, string> = { settings: "Its questions", telegram: "Link Telegram", google: "Your sheets", typeform: "Your Typeform", rules: "Rules and limits", test: "Test run" };
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const POLL_MS = 2_000;

interface Saved {
  answers: InstallAnswers;
  at: StepKey;
  installationId: string | null;
}

function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

const asText = (v: unknown): string => (v === undefined || v === null ? "" : Array.isArray(v) ? v.join(", ") : String(v));

function load(key: string): Saved | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Saved) : null;
  } catch {
    return null;
  }
}

function save(key: string, s: Saved | null): void {
  try {
    if (s) window.sessionStorage.setItem(key, JSON.stringify(s));
    else window.sessionStorage.removeItem(key);
  } catch {
    // Private windows: the flow still works, it just can't survive a reload.
  }
}

export function SetupFlow({
  agentId,
  setup: d,
  defaults,
  api,
  returnTo,
  onDone,
  onCancel,
}: {
  agentId: string;
  // What setting it up needs of the agent (never its code or prompts).
  setup: SetupShape;
  defaults: Record<string, unknown>;
  api: SetupApi;
  // This page, for coming back from Google.
  returnTo: string;
  onDone: (installationId: string) => void;
  onCancel?: () => void;
}) {
  const key = `bos-setup:${agentId}`;
  const needs = d.needs;
  const plainSettings = d.settings.filter((s) => s.type !== "sheet");
  const sheetSettings = d.settings.filter((s) => s.type === "sheet");
  const schedule = d.triggers.find((t) => t.kind === "schedule");
  const steps = useMemo<StepKey[]>(
    () => [...(plainSettings.length ? (["settings"] as const) : []), ...(needs.telegram ? (["telegram"] as const) : []), ...(needs.google ? (["google"] as const) : []), ...(needs.typeform ? (["typeform"] as const) : []), "rules", "test"],
    [plainSettings.length, needs.telegram, needs.google, needs.typeform],
  );
  const fresh = (): InstallAnswers => ({
    settings: Object.fromEntries(d.settings.map((s) => [s.key, s.type === "boolean" ? Boolean(defaults[s.key]) : s.type === "sheet" ? null : asText(defaults[s.key])])),
    rules: Object.fromEntries(d.rules.map((r) => [r.key, r.value])),
    timezone: browserZone(),
    schedule:
      schedule?.kind === "schedule"
        ? {
            at: schedule.at ?? null,
            day: schedule.every === "week" ? (schedule.days?.[0] ?? 1) : null,
            days: schedule.every === "week" ? (schedule.days?.length ? schedule.days : [1]) : null,
            interval: schedule.every === "minutes" || schedule.every === "hours" ? (schedule.interval ?? null) : null,
          }
        : null,
    minGapMinutes: DEFAULT_MIN_GAP_MINUTES,
    dailySpendUsd: DEFAULT_DAILY_SPEND_USD,
    autoSpendUsdc: 0,
  });
  const [state, setState] = useState<Saved>(() => ({ answers: fresh(), at: steps[0]!, installationId: null }));
  const [restored, setRestored] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [conn, setConn] = useState<Awaited<ReturnType<SetupApi["connections"]>> | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<SVGPathElement>(null);

  // Back from Google (or a reload): where it was.
  useEffect(() => {
    const was = load(key);
    if (was && steps.includes(was.at)) setState(was);
    setRestored(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (restored) save(key, state);
  }, [key, state, restored]);

  const refresh = useCallback(() => api.connections().then(setConn, () => undefined), [api]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const at = steps.indexOf(state.at);
  // How far along the line is drawn: to the step it is on.
  const reach = 1 + 98 * (at / Math.max(1, steps.length - 1));
  useLayoutEffect(() => {
    if (prefersReducedMotion()) return;
    if (panelRef.current) animate(panelRef.current, { ...dustIn, translateY: { from: 6, to: 0 }, duration: 320, ease: ease.arrive });
    if (lineRef.current && at > 0) animate(svg.createDrawable(lineRef.current, 0, 0), { draw: ["0 0", "0 1"], duration: 420, ease: ease.draw });
  }, [at]);

  const set = (patch: Partial<InstallAnswers>) => setState((s) => ({ ...s, answers: { ...s.answers, ...patch } }));
  const setSetting = (k: string, v: unknown) => setState((s) => ({ ...s, answers: { ...s.answers, settings: { ...s.answers.settings, [k]: v } } }));
  const linked = (p: "telegram" | "google" | "typeform", c = conn) => Boolean(c?.connections.some((x) => x.provider === p));

  // The answers' problems that belong to this step.
  const problems = (step: StepKey): Record<string, string> => {
    const checked = checkAnswers(d, state.answers);
    if (checked.ok) return {};
    const mine = (k: string) =>
      step === "settings" ? plainSettings.some((s) => s.key === k) : step === "google" ? sheetSettings.some((s) => s.key === k) : step === "rules" ? k.startsWith("rule:") || ["timezone", "schedule", "minGapMinutes", "dailySpendUsd"].includes(k) : false;
    return Object.fromEntries(Object.entries(checked.errors).filter(([k]) => mine(k)));
  };

  // On to the next step, with the connections as they are now.
  const next = async () => {
    setSaid(null);
    setBusy(true);
    const now = await api.connections().catch(() => conn);
    setBusy(false);
    if (now) setConn(now);
    if (state.at === "telegram" && !linked("telegram", now)) return setSaid("Link Telegram first: this agent messages you there.");
    if (state.at === "google" && !linked("google", now)) return setSaid("Connect Google first: this agent works on your sheets.");
    if (state.at === "typeform" && !linked("typeform", now)) return setSaid("Connect Typeform first: this agent reads your form's answers.");
    const found = problems(state.at);
    setErrors(found);
    if (Object.keys(found).length) return setSaid("Some answers need another look.");
    setState((s) => ({ ...s, at: steps[Math.min(at + 1, steps.length - 1)]! }));
  };
  const back = () => {
    setSaid(null);
    setErrors({});
    setState((s) => ({ ...s, at: steps[Math.max(at - 1, 0)]! }));
  };

  const err = (k: string) =>
    errors[k] ? (
      <span className={styles.error} id={`setup-err-${k}`}>
        {errors[k]}
      </span>
    ) : null;

  return (
    <section className={styles.flow} aria-label="Set it up">
      <div className={styles.steps}>
        <svg className={styles.track} viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true">
          <path d="M1 2 L99 2" className={styles.trackBase} />
          {at > 0 && <path ref={lineRef} d={`M1 2 L${reach} 2`} className={styles.trackDone} />}
        </svg>
        <ol>
          {steps.map((s, i) => (
            <li key={s} data-state={i < at ? "done" : i === at ? "here" : "ahead"} aria-current={i === at ? "step" : undefined}>
              <span className={styles.dot} aria-hidden="true">
                {i + 1}
              </span>
              <span className={styles.stepName}>{STEP_TITLE[s]}</span>
            </li>
          ))}
        </ol>
      </div>

      <div className={styles.panel} ref={panelRef} key={state.at}>
        {state.at === "settings" && (
          <div className={styles.fields}>
            <p className={styles.quiet}>What {d.name} needs to know from you.</p>
            {plainSettings.map((s) => (
              <label key={s.key} className={styles.field}>
                <span className={styles.label}>{s.label}</span>
                {s.type === "boolean" ? (
                  <input type="checkbox" checked={Boolean(state.answers.settings[s.key])} onChange={(e) => setSetting(s.key, e.target.checked)} />
                ) : s.type === "choice" ? (
                  <select className={styles.select} value={asText(state.answers.settings[s.key])} onChange={(e) => setSetting(s.key, e.target.value)}>
                    <option value="">Pick one</option>
                    {s.choices.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                ) : (
                  <TextInput
                    type={s.type === "number" ? "number" : s.type === "url" ? "url" : "text"}
                    value={asText(state.answers.settings[s.key])}
                    placeholder={s.type === "list" ? "separated by commas" : undefined}
                    aria-invalid={Boolean(errors[s.key])}
                    aria-describedby={errors[s.key] ? `setup-err-${s.key}` : undefined}
                    onChange={(e) => setSetting(s.key, e.target.value)}
                  />
                )}
                <span className={styles.help}>{s.help}</span>
                {err(s.key)}
              </label>
            ))}
          </div>
        )}

        {state.at === "telegram" && (
          <div className={styles.fields}>
            <p className={styles.quiet}>
              {d.name} messages you and asks you things in Telegram, with a button per answer. You can answer here too: whichever comes first counts.
            </p>
            {linked("telegram") ? (
              <p className={styles.done}>Linked to {conn!.connections.find((c) => c.provider === "telegram")!.label}.</p>
            ) : conn && !conn.available.telegram ? (
              <p className={styles.quiet}>Telegram isn&apos;t set up on this server.</p>
            ) : (
              <TelegramLink getCode={api.telegramCode} refresh={refresh} />
            )}
          </div>
        )}

        {state.at === "typeform" && (
          <div className={styles.fields}>
            <p className={styles.quiet}>{d.name} reads the answers to your Typeform form with your own token, each answer once.</p>
            {linked("typeform") ? (
              <p className={styles.done}>Connected: {conn!.connections.find((c) => c.provider === "typeform")!.label}.</p>
            ) : api.connectTypeform ? (
              <TypeformConnect connect={api.connectTypeform} onConnected={refresh} />
            ) : (
              <p className={styles.quiet}>Connect Typeform on Connections, then come back.</p>
            )}
          </div>
        )}

        {state.at === "google" && (
          <div className={styles.fields}>
            {linked("google") ? (
              <p className={styles.done}>Google is connected as {conn!.connections.find((c) => c.provider === "google")!.label}. Paste each sheet&apos;s link and pick its tab: these are the only tabs it can reach.</p>
            ) : conn && !conn.available.google ? (
              <p className={styles.quiet}>Google isn&apos;t set up on this server.</p>
            ) : (
              <GoogleConnect start={api.googleStart} returnTo={returnTo} />
            )}
            {linked("google") &&
              sheetSettings.map((s) => (
                <div key={s.key} className={styles.field}>
                  <label className={styles.label} htmlFor={`setup-${s.key}`}>
                    {s.label}
                  </label>
                  <SheetField
                    id={`setup-${s.key}`}
                    value={isSheetAnswer(state.answers.settings[s.key]) ? (state.answers.settings[s.key] as { url: string; tab: string }) : null}
                    onChange={(v) => setSetting(s.key, v)}
                    inspect={api.inspectSheet}
                    invalid={Boolean(errors[s.key])}
                    describedBy={errors[s.key] ? `setup-err-${s.key}` : undefined}
                  />
                  <span className={styles.help}>{s.help}</span>
                  {err(s.key)}
                </div>
              ))}
          </div>
        )}

        {state.at === "rules" && (
          <div className={styles.fields}>
            {d.rules.map((r) => (
              <label key={r.key} className={styles.field}>
                <span className={styles.label}>
                  {r.label}
                  {r.type === "usdc" ? " (USDC)" : ""}
                </span>
                <TextInput value={state.answers.rules[r.key] ?? ""} aria-invalid={Boolean(errors[`rule:${r.key}`])} onChange={(e) => set({ rules: { ...state.answers.rules, [r.key]: e.target.value } })} />
                <span className={styles.help}>
                  {r.help} The maker&apos;s default is {r.value || "empty"}.
                </span>
                {err(`rule:${r.key}`)}
              </label>
            ))}
            <label className={styles.field}>
              <span className={styles.label}>Your time zone</span>
              <TextInput value={state.answers.timezone} onChange={(e) => set({ timezone: e.target.value })} aria-invalid={Boolean(errors.timezone)} />
              {err("timezone")}
            </label>
            {schedule?.kind === "schedule" && (schedule.every === "minutes" || schedule.every === "hours") && (
              <label className={styles.field}>
                <span className={styles.label}>Every ({schedule.every === "minutes" ? `minutes, at least ${minIntervalMinutes()}` : "hours"})</span>
                <TextInput
                  type="number"
                  min={schedule.every === "minutes" ? minIntervalMinutes() : 1}
                  max={schedule.every === "minutes" ? 1440 : 24}
                  step={1}
                  value={String(state.answers.schedule?.interval ?? schedule.interval ?? "")}
                  onChange={(e) => set({ schedule: { ...state.answers.schedule!, interval: e.target.value ? Number(e.target.value) : null } })}
                  aria-invalid={Boolean(errors.schedule)}
                />
              </label>
            )}
            {schedule?.kind === "schedule" && (schedule.every === "day" || schedule.every === "week") && (
              <div className={styles.row}>
                {schedule.every === "week" && (
                  <fieldset className={styles.days}>
                    <legend className={styles.label}>On</legend>
                    {DAYS.map((name, i) => {
                      const days = state.answers.schedule?.days ?? [1];
                      return (
                        <label key={name} className={styles.day}>
                          <input
                            type="checkbox"
                            checked={days.includes(i)}
                            onChange={(e) => {
                              const next = e.target.checked ? [...days, i] : days.filter((x) => x !== i);
                              set({ schedule: { at: state.answers.schedule?.at ?? null, day: next[0] ?? null, days: next, interval: null } });
                            }}
                          />
                          {name.slice(0, 3)}
                        </label>
                      );
                    })}
                  </fieldset>
                )}
                <label className={styles.field}>
                  <span className={styles.label}>At</span>
                  <TextInput type="time" value={state.answers.schedule?.at ?? ""} onChange={(e) => set({ schedule: { ...state.answers.schedule!, at: e.target.value || null } })} aria-invalid={Boolean(errors.schedule)} />
                </label>
              </div>
            )}
            {err("schedule")}
            {d.spends && (
              <label className={styles.field}>
                <span className={styles.label}>Spend without asking you, per payment or order (USDC)</span>
                <TextInput type="number" min={0} max={1000} step={1} value={String(state.answers.autoSpendUsdc ?? 0)} onChange={(e) => set({ autoSpendUsdc: Math.max(0, Number(e.target.value) || 0) })} />
                <span className={styles.quiet}>Anything over it waits for your yes. 0 means it asks before every spend.</span>
              </label>
            )}
            <div className={styles.row}>
              <label className={styles.field}>
                <span className={styles.label}>Model spend a day, at most (US dollars)</span>
                <TextInput type="number" min={0} max={MAX_DAILY_SPEND_USD} step={0.05} value={String(state.answers.dailySpendUsd ?? "")} onChange={(e) => set({ dailySpendUsd: Number(e.target.value) })} aria-invalid={Boolean(errors.dailySpendUsd)} />
                {err("dailySpendUsd")}
              </label>
              <label className={styles.field}>
                <span className={styles.label}>Minutes between jobs, at least</span>
                <TextInput type="number" min={0} max={1440} step={1} value={String(state.answers.minGapMinutes ?? "")} onChange={(e) => set({ minGapMinutes: Number(e.target.value) })} aria-invalid={Boolean(errors.minGapMinutes)} />
                {err("minGapMinutes")}
              </label>
            </div>
          </div>
        )}

        {state.at === "test" && (
          <TestRun
            api={api}
            answers={state.answers}
            installationId={state.installationId}
            setInstallationId={(id) => setState((s) => ({ ...s, installationId: id }))}
            onLive={(id) => {
              save(key, null);
              onDone(id);
            }}
            onChange={() => setState((s) => ({ ...s, installationId: null, at: steps[0]! }))}
            setErrors={setErrors}
          />
        )}
      </div>

      {said && (
        <p className={styles.said} role="status">
          {said}
        </p>
      )}
      <div className={styles.actions}>
        {onCancel && state.at !== "test" && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              save(key, null);
              onCancel();
            }}
            disabled={busy}
          >
            Not now
          </Button>
        )}
        {at > 0 && state.at !== "test" && (
          <Button variant="ghost" size="sm" onClick={back} disabled={busy}>
            Back
          </Button>
        )}
        {state.at !== "test" && (
          <Button size="sm" onClick={() => void next()} disabled={busy}>
            Next
          </Button>
        )}
      </div>
    </section>
  );
}

// The last step: set up, not live; one test run, for real, drawn as it
// goes; then live.
function TestRun({
  api,
  answers,
  installationId,
  setInstallationId,
  onLive,
  onChange,
  setErrors,
}: {
  api: SetupApi;
  answers: InstallAnswers;
  installationId: string | null;
  setInstallationId: (id: string) => void;
  onLive: (id: string) => void;
  onChange: () => void;
  setErrors: (e: Record<string, string>) => void;
}) {
  const [inst, setInst] = useState<InstallationDTO | null>(null);
  const [job, setJob] = useState<JobDTO | null>(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);

  useEffect(() => {
    if (installationId) void api.installation(installationId).then(setInst, () => setSaid("Its setup couldn't load. Try again."));
  }, [api, installationId]);

  // The test job, as it runs.
  const testJob = inst?.recentJobs.find((j) => j.trigger === "test") ?? null;
  const live = Boolean(testJob && ["queued", "running", "waiting_for_owner"].includes(testJob.status));
  useEffect(() => {
    if (!inst || !live) return;
    const t = setInterval(() => void api.installation(inst.id).then(setInst, () => undefined), POLL_MS);
    return () => clearInterval(t);
  }, [api, inst, live]);
  useEffect(() => {
    if (testJob) void api.job(testJob.id).then(setJob, () => undefined);
  }, [api, testJob?.id, testJob?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setSaid(null);
    try {
      await fn();
    } catch (err) {
      const fieldErrors = (err as { errors?: Record<string, string> }).errors;
      if (fieldErrors && Object.keys(fieldErrors).length) {
        setErrors(fieldErrors);
        setSaid(`${err instanceof Error ? err.message : "Some answers need another look."} Go back to change them.`);
      } else setSaid(err instanceof Error ? err.message : "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  };

  if (!installationId) {
    return (
      <div className={styles.fields}>
        <p>Next, a test run: it does everything once, for real, now. It reads your sheets, asks you on Telegram before anything over your limits, and writes what it would write. Nothing else starts it until you make it live.</p>
        <div className={styles.actions}>
          <Button variant="ghost" size="sm" onClick={onChange} disabled={busy}>
            Change answers
          </Button>
          <Button size="sm" onClick={() => void act(async () => setInstallationId((await api.install(answers)).id))} disabled={busy}>
            {busy ? "Setting it up..." : "Set it up for a test"}
          </Button>
        </div>
        {said && (
          <p className={styles.said} role="status">
            {said}
          </p>
        )}
      </div>
    );
  }
  const ended = testJob && !live;
  return (
    <div className={styles.fields}>
      {!testJob && <p>It&apos;s set up, not live. Run the test when you&apos;re ready.</p>}
      {job && <JobTimeline key={job.id} initial={job} api={{ load: () => api.job(job.id), answer: api.answer }} />}
      {ended && testJob!.status === "done" && <p className={styles.done}>The test went through. Make it live to run on its own from now on.</p>}
      {ended && testJob!.status !== "done" && <p className={styles.said}>The test didn&apos;t finish{testJob!.reason ? `: ${testJob!.reason}` : "."} Run it again, or change your answers.</p>}
      <div className={styles.actions}>
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            void act(async () => {
              await api.control(installationId, "stop");
              onChange();
            })
          }
          disabled={busy || live}
        >
          Change answers
        </Button>
        {!live && (
          <Button size="sm" variant={ended && testJob!.status === "done" ? "ghost" : undefined} onClick={() => void act(async () => setInst(await api.control(installationId, "test")))} disabled={busy}>
            {testJob ? "Run another test" : "Run the test"}
          </Button>
        )}
        {ended && testJob!.status === "done" && (
          <Button size="sm" onClick={() => void act(async () => onLive((await api.control(installationId, "golive")).id))} disabled={busy}>
            Make it live
          </Button>
        )}
      </div>
      {said && (
        <p className={styles.said} role="status">
          {said}
        </p>
      )}
    </div>
  );
}
