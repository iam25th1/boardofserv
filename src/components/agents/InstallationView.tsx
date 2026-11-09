"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button, Textarea } from "@/components/ui";
import { animateEnter } from "@/lib/motion";
import type { AgentMessageDTO, InstallationDTO } from "@/lib/types";
import styles from "./InstallationView.module.css";

// One agent running for its owner: when it runs and when next, its settings
// and rules, and its in-app message box. The page polls while it is open.

export interface InstallationApi {
  load: () => Promise<InstallationDTO>;
  messages: () => Promise<AgentMessageDTO[]>;
  send: (text: string) => Promise<AgentMessageDTO>;
}

const POLL_MS = 5_000;

export function when(iso: string | null, timezone: string): string {
  if (!iso) return "not scheduled";
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: timezone, weekday: "short", hour: "numeric", minute: "2-digit", day: "numeric", month: "short" }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleString();
  }
}

const shown = (v: unknown) => (Array.isArray(v) ? v.join(", ") : v === null || v === undefined || v === "" ? "not set" : String(v));

export function InstallationView({ initial, api, children }: { initial: InstallationDTO; api: InstallationApi; children?: React.ReactNode }) {
  const [data, setData] = useState(initial);
  const [messages, setMessages] = useState<AgentMessageDTO[] | null>(null);

  const refresh = useCallback(async () => {
    const [d, m] = await Promise.all([api.load(), data.takesMessages ? api.messages() : Promise.resolve(null)]);
    setData(d);
    if (m) setMessages(m);
  }, [api, data.takesMessages]);

  useEffect(() => {
    void refresh().catch(() => undefined);
    const t = setInterval(() => void refresh().catch(() => undefined), POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <div className={styles.view}>
      <header className={styles.head}>
        <div>
          <h1>{data.name}</h1>
          <p className={styles.quiet}>
            version {data.version}, times in {data.timezone}
          </p>
        </div>
        <span className={styles.status} data-status={data.status}>
          {data.status}
        </span>
      </header>
      <section className={styles.section} aria-label="When it runs">
        <ul className={styles.runs}>
          {data.runs.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        <p className={styles.next}>
          {data.status === "active" ? (data.nextRunAt ? `Next: ${when(data.nextRunAt, data.timezone)}` : "Waits for your messages") : data.status === "paused" ? "Paused: nothing new runs" : "Stopped"}
        </p>
        {data.checkNote && <p className={styles.note}>{data.checkNote}</p>}
      </section>
      {children}
      {data.takesMessages && <MessageBox messages={messages} send={api.send} onSent={() => void refresh()} disabled={data.status === "stopped"} />}
      {data.memory.length > 0 && (
        <section className={styles.section} aria-label="What it remembers">
          <h2>What it remembers for you</h2>
          <dl className={styles.pairs}>
            {data.memory.map((m) => (
              <div key={m.key}>
                <dt>{m.description}</dt>
                <dd>{m.value === null ? "nothing yet" : typeof m.value === "string" ? m.value : <code className={styles.code}>{JSON.stringify(m.value)}</code>}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      <section className={styles.section} aria-label="Its settings">
        <h2>Its settings</h2>
        <dl className={styles.pairs}>
          {data.settings.map((s) => (
            <div key={s.key}>
              <dt>{s.label}</dt>
              <dd>{shown(s.value)}</dd>
            </div>
          ))}
          {data.rules.map((r) => (
            <div key={r.key}>
              <dt>{r.label}</dt>
              <dd>
                {shown(r.value)}
                {r.type === "usdc" ? " USDC" : ""}
              </dd>
            </div>
          ))}
          <div>
            <dt>Model spend a day, at most</dt>
            <dd>${data.dailySpendUsd.toFixed(2)}</dd>
          </div>
          <div>
            <dt>Minutes between jobs, at least</dt>
            <dd>{data.minGapMinutes}</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}

function MessageBox({ messages, send, onSent, disabled }: { messages: AgentMessageDTO[] | null; send: (text: string) => Promise<AgentMessageDTO>; onSent: () => void; disabled: boolean }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const seen = useRef(0);
  const id = useId();

  useEffect(() => {
    const list = listRef.current;
    if (!list || !messages) return;
    const fresh = [...list.children].slice(seen.current);
    if (seen.current) animateEnter(fresh);
    seen.current = messages.length;
  }, [messages]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    setSaid(null);
    try {
      await send(text.trim());
      setText("");
      onSent();
    } catch (err) {
      setSaid(err instanceof Error ? err.message : "It could not be sent. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.section} aria-label="Messages">
      <h2>Messages</h2>
      <p className={styles.quiet}>Each message you send starts a job with it. What the agent tells you shows here too (Telegram comes later).</p>
      {messages === null ? (
        <p className={styles.loading}>getting messages</p>
      ) : messages.length === 0 ? (
        <p className={styles.quiet}>Nothing yet.</p>
      ) : (
        <ol className={styles.messages} ref={listRef}>
          {messages.map((m) => (
            <li key={m.id} data-from={m.from}>
              <span className={styles.who}>{m.from === "owner" ? "you" : "the agent"}</span>
              <p>{m.text}</p>
            </li>
          ))}
        </ol>
      )}
      <form className={styles.send} onSubmit={(e) => void submit(e)}>
        <label htmlFor={id} className="visually-hidden">
          Message the agent
        </label>
        <Textarea id={id} rows={2} value={text} maxLength={2000} placeholder="Message the agent" onChange={(e) => setText(e.target.value)} disabled={disabled || busy} />
        <Button type="submit" size="sm" disabled={disabled || busy || !text.trim()}>
          {busy ? "Sending..." : "Send"}
        </Button>
      </form>
      {said && (
        <p className={styles.note} role="status">
          {said}
        </p>
      )}
    </section>
  );
}
