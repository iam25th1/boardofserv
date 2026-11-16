"use client";
import { useStaggerIn } from "@/lib/useStaggerIn";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { createTimeline, svg, utils } from "animejs";
import { Button, Dialog, SkeletonRows, TextInput } from "@/components/ui";
import { dustIn, ease, prefersReducedMotion } from "@/lib/motion";
import { CATALOG, CATEGORIES, type ServiceEntry } from "@/lib/connections/catalog";
import type { ConnectionDTO } from "@/lib/types";
import styles from "./ConnectionsView.module.css";

// The owner's connections: every service of the catalog, by category, with
// a search to find one. Each card says what the service reads and writes
// and whether it is connected (as what, since when, what uses it); a
// service that isn't says where to get a key and takes it, checked once
// with the service before it is kept. A connection only reads until the
// owner turns writing on with its switch, and Disconnect removes it after
// a yes. A card that becomes connected draws its chalk line under the
// name; with reduced motion it is simply there. Secrets never reach this
// page: only labels and dates do.

export interface ConnectionsApi {
  load: () => Promise<{ connections: ConnectionDTO[]; available: Record<string, boolean> }>;
  disconnect: (provider: string) => Promise<{ revoked: boolean | null; paused: number }>;
  // A keyed service, connected with what the owner pastes.
  connect?: (provider: string, fields: Record<string, string>) => Promise<{ label: string }>;
  setWrites?: (provider: string, writes: boolean) => Promise<{ writes: boolean }>;
}

// Telegram, Google and Typeform say it in their own words.
const FOR: Record<string, string> = {
  telegram: "Your agents message you and ask you things in Telegram, and you can message them back. Answer with a button there or here, whichever comes first.",
  google: "Your agents read and write the Google Sheets you give them, and only those, tab by tab.",
  typeform: "Your agents read the answers to the Typeform forms you give them, each new answer once, with your own personal token.",
};

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });

// How to connect a service that isn't connected: given a way to look again
// (a link made in Telegram shows up here without a reload).
export type Connector = (refresh: () => Promise<void>) => React.ReactNode;

// Whether a service matches what the owner typed: its name, the words a
// maker uses for it, its category or what it reads.
function matches(e: ServiceEntry, q: string): boolean {
  const t = q.trim().toLowerCase();
  if (!t) return true;
  const category = CATEGORIES.find((c) => c.id === e.category)?.name ?? "";
  return [e.name, e.short ?? "", category, e.reads, ...e.aliases].some((w) => w.toLowerCase().includes(t));
}

export function ConnectionsView({ api, connect, focus, onConnected }: { api: ConnectionsApi; connect?: Partial<Record<string, Connector>>; focus?: string | null; onConnected?: (provider: string) => void | Promise<void> }) {
  const [data, setData] = useState<Awaited<ReturnType<ConnectionsApi["load"]>> | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const searchId = useId();
  const listRef = useStaggerIn<HTMLDivElement>(Boolean(data));
  const load = useCallback(() => api.load().then(setData, () => setFailed(true)), [api]);
  const refresh = useCallback(() => api.load().then(setData, () => undefined), [api]);
  useEffect(() => {
    void load();
  }, [load]);
  const shown = useMemo(() => CATALOG.filter((e) => matches(e, query)), [query]);
  if (failed) return <p className={styles.quiet}>Your connections could not load. Try again in a moment.</p>;
  if (!data) return <SkeletonRows label="Getting your connections" count={2} />;
  const connected = CATALOG.filter((e) => data.connections.some((c) => c.provider === e.id)).length;
  return (
    <div className={styles.page}>
      <div className={styles.search}>
        <label htmlFor={searchId} className={styles.searchLabel}>
          Find a service
        </label>
        <TextInput id={searchId} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="GitHub, Discord, email, prices..." autoComplete="off" />
        <p className={styles.quiet}>
          {connected === 0 ? "Nothing connected yet." : `${connected} connected.`} Every connection only reads until you turn writing on.
        </p>
      </div>
      {!shown.length && (
        <p className={styles.quiet}>
          Nothing here goes by &ldquo;{query.trim()}&rdquo;. A service with an https API can still be reached:{" "}
          <button type="button" className={styles.inline} onClick={() => setQuery("Custom API")}>
            use Custom API
          </button>
          .
        </p>
      )}
      <div ref={listRef} className={styles.groups}>
        {CATEGORIES.map((cat) => {
          const entries = shown.filter((e) => e.category === cat.id);
          if (!entries.length) return null;
          return (
            <section key={cat.id} className={styles.group} aria-labelledby={`cat-${cat.id}`} data-enter>
              <h2 id={`cat-${cat.id}`} className={styles.groupName}>
                {cat.name}
              </h2>
              <ul className={styles.list}>
                {entries.map((e) => (
                  <li key={e.id}>
                    <ServiceCard
                      entry={e}
                      connection={data.connections.find((c) => c.provider === e.id) ?? null}
                      available={data.available[e.id] !== false}
                      open={focus === e.id}
                      connect={connect?.[e.id]?.(refresh)}
                      api={api}
                      onConnected={async () => {
                        await refresh();
                        await onConnected?.(e.id);
                      }}
                      onChanged={refresh}
                      onDisconnect={async () => {
                        const r = await api.disconnect(e.id);
                        await load();
                        return r;
                      }}
                    />
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}

const KEYED = ["api_key", "bearer", "bot_token", "webhook_url"];

function ServiceCard({
  entry: e,
  connection: c,
  available,
  open: opened,
  connect,
  api,
  onConnected,
  onChanged,
  onDisconnect,
}: {
  entry: ServiceEntry;
  connection: ConnectionDTO | null;
  available: boolean;
  open: boolean;
  connect?: React.ReactNode;
  api: ConnectionsApi;
  onConnected: () => Promise<void>;
  onChanged: () => Promise<void>;
  onDisconnect: () => Promise<{ revoked: boolean | null; paused: number }>;
}) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [open, setOpen] = useState(opened);
  const lineRef = useRef<SVGPathElement>(null);
  const wordsRef = useRef<HTMLDivElement>(null);
  const was = useRef<boolean | null>(null);
  const name = e.short ?? e.name;
  const keyless = e.auth === "none";

  // Sent here to connect this one: it opens and comes into view.
  useEffect(() => {
    if (!opened) return;
    setOpen(true);
    const t = setTimeout(() => document.getElementById(`connect-${e.id}`)?.scrollIntoView({ block: "center" }), 400);
    return () => clearTimeout(t);
  }, [opened, e.id]);

  // Drawn once when it becomes connected (not on every load).
  useLayoutEffect(() => {
    const connected = Boolean(c);
    const before = was.current;
    was.current = connected;
    if (!connected || before !== false || prefersReducedMotion()) return;
    const line = lineRef.current;
    const words = wordsRef.current;
    const tl = createTimeline({ defaults: { ease: ease.draw } });
    if (line) tl.add(svg.createDrawable(line, 0, 0), { draw: ["0 0", "0 1"], duration: 520 }, 0);
    if (words) {
      utils.set(words, { opacity: 0 });
      tl.add(words, { ...dustIn, duration: 360 }, 240);
    }
  }, [c]);

  const go = async () => {
    setBusy(true);
    try {
      const r = await onDisconnect();
      const paused = r.paused ? ` ${r.paused} ${r.paused === 1 ? "agent is" : "agents are"} paused until you connect it again.` : "";
      const revoked = r.revoked === false ? " Google couldn't be reached to revoke its access, so remove boardofserv at myaccount.google.com too." : "";
      setSaid(`Disconnected.${paused}${revoked}`);
      setAsking(false);
    } catch (err) {
      setSaid(err instanceof Error ? err.message : "It could not disconnect. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const flip = async () => {
    if (!c || !api.setWrites) return;
    setBusy(true);
    setSaid(null);
    try {
      const r = await api.setWrites(e.id, !c.writes);
      setSaid(r.writes ? `Your agents may now write to ${name}, still asking first wherever you or the agent said to.` : `Your agents only read ${name} now.`);
      await onChanged();
    } catch (err) {
      setSaid(err instanceof Error ? err.message : "It could not change. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const state = c ? (e.id === "telegram" ? "linked" : "connected") : keyless ? "no key needed" : "not connected";
  return (
    <section className={styles.card} id={`connect-${e.id}`} data-connected={c ? "true" : "false"} aria-labelledby={`svc-${e.id}`}>
      <header className={styles.head}>
        <h3 id={`svc-${e.id}`} className={styles.name}>
          {e.name}
          <svg className={styles.line} viewBox="0 0 120 8" preserveAspectRatio="none" aria-hidden="true">
            {c && <path ref={lineRef} d="M2 5 C 30 2, 60 7, 118 3" />}
          </svg>
        </h3>
        <span className={styles.state}>{state}</span>
      </header>
      <p className={styles.for}>{FOR[e.id] ?? e.reads}</p>
      {e.writes && !FOR[e.id] && <p className={styles.for}>With writing on: {lowerFirst(e.writes)}</p>}
      {c ? (
        <div className={styles.details} ref={wordsRef}>
          <p>
            {e.id === "telegram" ? "Linked to " : "Connected as "}
            <strong>{c.label}</strong>, since {when(c.connectedAt)}.{c.lastUsedAt ? ` Last used ${when(c.lastUsedAt)}.` : ""}
          </p>
          <p className={styles.quiet}>
            {c.usedBy.length ? (
              <>
                Used by{" "}
                {c.usedBy.map((i, n) => (
                  <span key={i.id}>
                    {n > 0 ? ", " : ""}
                    <Link href={`/app/installations/${i.id}`}>{i.name}</Link>
                    {i.status === "paused" ? " (paused)" : ""}
                  </span>
                ))}
                .
              </>
            ) : (
              "No agent of yours uses it yet."
            )}
          </p>
          {e.writes && api.setWrites && (
            <div className={styles.switchRow}>
              <button type="button" role="switch" className={styles.toggle} aria-checked={c.writes} aria-labelledby={`writes-${e.id}`} disabled={busy} onClick={() => void flip()} />
              <span id={`writes-${e.id}`}>{c.writes ? `Agents may write to ${name}` : `Agents only read ${name}`}</span>
            </div>
          )}
          <div className={styles.actions}>
            <Button variant="ghost" size="sm" onClick={() => setAsking(true)}>
              Disconnect
            </Button>
          </div>
        </div>
      ) : !available ? (
        <p className={styles.quiet}>It isn&apos;t set up on this server.</p>
      ) : keyless ? (
        <p className={styles.quiet}>Nothing to connect. {e.keyHow.replace(/^Nothing to connect: /, "").replace(/^./, (x) => x.toUpperCase())}</p>
      ) : connect ? (
        connect
      ) : KEYED.includes(e.auth) && api.connect ? (
        open ? (
          <KeyConnect entry={e} connect={(fields) => api.connect!(e.id, fields)} onConnected={onConnected} />
        ) : (
          <div className={styles.actions}>
            <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
              Connect {name}
            </Button>
          </div>
        )
      ) : null}
      {said && (
        <p className={styles.said} role="status">
          {said}
        </p>
      )}
      <Dialog
        open={asking}
        onClose={() => setAsking(false)}
        title={`Disconnect ${e.name}?`}
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => setAsking(false)} disabled={busy}>
              Keep it
            </Button>
            <Button size="sm" onClick={() => void go()} disabled={busy}>
              {busy ? "Disconnecting..." : "Disconnect"}
            </Button>
          </>
        }
      >
        <p>
          {e.id === "google"
            ? "boardofserv asks Google to revoke its access and forgets it here. Your sheets stay as they are."
            : e.id === "telegram"
              ? "boardofserv forgets your chat. It sends nothing there again until you link it."
              : `boardofserv forgets your ${keyNoun(e)} here. Delete it in ${name} too if nothing else uses it. What is in ${name} stays as it is.`}
        </p>
        {c && c.usedBy.some((i) => i.status === "active") && (
          <p>
            {c.usedBy
              .filter((i) => i.status === "active")
              .map((i) => i.name)
              .join(", ")}{" "}
            will pause until you connect it again.
          </p>
        )}
      </Dialog>
    </section>
  );
}

const lowerFirst = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);
const keyNoun = (e: ServiceEntry) => (e.fields.find((f) => f.secret)?.label ?? "key").toLowerCase();

// Connecting a service with what the owner pastes: each field the service
// needs, a secret one hidden as it is typed. It is checked once with the
// service, kept encrypted and never shown again.
function KeyConnect({ entry: e, connect, onConnected }: { entry: ServiceEntry; connect: (fields: Record<string, string>) => Promise<{ label: string }>; onConnected: () => Promise<void> }) {
  const id = useId();
  const [fields, setFields] = useState<Record<string, string>>(() => Object.fromEntries(e.fields.map((f) => [f.key, f.choices?.[0] ?? ""])));
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const name = e.short ?? e.name;
  const ready = e.fields.every((f) => f.optional || fields[f.key]?.trim());
  const go = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setSaid(null);
    try {
      await connect(Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v)));
      setFields(Object.fromEntries(e.fields.map((f) => [f.key, f.choices?.[0] ?? ""])));
      await onConnected();
    } catch (err) {
      setSaid(err instanceof Error ? err.message : "It couldn't connect. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className={styles.details}
      onSubmit={(ev) => {
        ev.preventDefault();
        void go();
      }}
    >
      <p className={styles.quiet}>
        {e.keyHow}{" "}
        {e.keyUrl && (
          <a href={e.keyUrl} target="_blank" rel="noopener noreferrer">
            Where to get it
          </a>
        )}
        {e.keyUrl ? ". " : ""}It is checked with {name}, kept encrypted and never shown again; agents only read through it until you turn writing on. More on <Link href="/privacy">Your data</Link>.
      </p>
      {e.fields.map((f) => (
        <div key={f.key} className={styles.field}>
          <label htmlFor={`${id}-${f.key}`} className={styles.quiet}>
            {f.label}
            {f.optional ? " (if it has one)" : ""}
          </label>
          {f.choices ? (
            <select id={`${id}-${f.key}`} className={styles.select} value={fields[f.key] ?? ""} onChange={(ev) => setFields((x) => ({ ...x, [f.key]: ev.target.value }))}>
              {f.choices.map((choice) => (
                <option key={choice}>{choice}</option>
              ))}
            </select>
          ) : (
            <TextInput
              id={`${id}-${f.key}`}
              type={f.secret ? "password" : "text"}
              autoComplete="off"
              spellCheck={false}
              value={fields[f.key] ?? ""}
              onChange={(ev) => setFields((x) => ({ ...x, [f.key]: ev.target.value }))}
              placeholder={f.placeholder}
            />
          )}
        </div>
      ))}
      <div className={styles.actions}>
        <Button size="sm" type="submit" disabled={busy || !ready}>
          {busy ? `Checking it with ${name}...` : `Connect ${name}`}
        </Button>
      </div>
      {said && (
        <p className={styles.said} role="status">
          {said}
        </p>
      )}
    </form>
  );
}
