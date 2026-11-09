"use client";
import { useStaggerIn } from "@/lib/useStaggerIn";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { createTimeline, svg, utils } from "animejs";
import { Button, Dialog, SkeletonRows } from "@/components/ui";
import { dustIn, ease, prefersReducedMotion } from "@/lib/motion";
import type { ConnectionDTO } from "@/lib/types";
import styles from "./ConnectionsView.module.css";

// The owner's connections, one card per service: what it is linked to,
// since when, what uses it, and Disconnect. A service that isn't connected
// says what it is for and how to connect it. A card that becomes connected
// draws its chalk line under the name; with reduced motion it is simply
// there. Secrets never reach this page: only labels and dates do.

type Provider = ConnectionDTO["provider"];

export interface ConnectionsApi {
  load: () => Promise<{ connections: ConnectionDTO[]; available: Record<Provider, boolean> }>;
  disconnect: (provider: Provider) => Promise<{ revoked: boolean | null; paused: number }>;
}

const FOR: Record<Provider, string> = {
  telegram: "Your agents message you and ask you things in Telegram, and you can message them back. Answer with a button there or here, whichever comes first.",
  google: "Your agents read and write the Google Sheets you give them, and only those, tab by tab.",
};

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });

// How to connect a service that isn't connected: given a way to look again
// (a link made in Telegram shows up here without a reload).
export type Connector = (refresh: () => Promise<void>) => React.ReactNode;

export function ConnectionsView({ api, connect }: { api: ConnectionsApi; connect?: Partial<Record<Provider, Connector>> }) {
  const [data, setData] = useState<Awaited<ReturnType<ConnectionsApi["load"]>> | null>(null);
  const [failed, setFailed] = useState(false);
  const listRef = useStaggerIn<HTMLUListElement>(Boolean(data));
  const load = useCallback(() => api.load().then(setData, () => setFailed(true)), [api]);
  const refresh = useCallback(() => api.load().then(setData, () => undefined), [api]);
  useEffect(() => {
    void load();
  }, [load]);
  if (failed) return <p className={styles.quiet}>Your connections could not load. Try again in a moment.</p>;
  if (!data) return <SkeletonRows label="Getting your connections" count={2} />;
  return (
    <ul className={styles.list} ref={listRef}>
      {(["telegram", "google"] as const).map((p) => (
        <li key={p} data-enter>
          <ServiceCard
            provider={p}
            connection={data.connections.find((c) => c.provider === p) ?? null}
            available={data.available[p]}
            connect={connect?.[p]?.(refresh)}
            onDisconnect={async () => {
              const r = await api.disconnect(p);
              await load();
              return r;
            }}
          />
        </li>
      ))}
    </ul>
  );
}

const NAME: Record<Provider, string> = { telegram: "Telegram", google: "Google Sheets" };

function ServiceCard({
  provider,
  connection: c,
  available,
  connect,
  onDisconnect,
}: {
  provider: Provider;
  connection: ConnectionDTO | null;
  available: boolean;
  connect?: React.ReactNode;
  onDisconnect: () => Promise<{ revoked: boolean | null; paused: number }>;
}) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const lineRef = useRef<SVGPathElement>(null);
  const wordsRef = useRef<HTMLDivElement>(null);
  const was = useRef<boolean | null>(null);

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

  return (
    <section className={styles.card} data-connected={c ? "true" : "false"} aria-labelledby={`svc-${provider}`}>
      <header className={styles.head}>
        <h2 id={`svc-${provider}`} className={styles.name}>
          {NAME[provider]}
          <svg className={styles.line} viewBox="0 0 120 8" preserveAspectRatio="none" aria-hidden="true">
            {c && <path ref={lineRef} d="M2 5 C 30 2, 60 7, 118 3" />}
          </svg>
        </h2>
        <span className={styles.state}>{c ? (provider === "telegram" ? "linked" : "connected") : "not connected"}</span>
      </header>
      <p className={styles.for}>{FOR[provider]}</p>
      {c ? (
        <div className={styles.details} ref={wordsRef}>
          <p>
            {provider === "telegram" ? "Linked to " : "Connected as "}
            <strong>{c.label}</strong>, since {when(c.connectedAt)}.
            {c.lastUsedAt ? ` Last used ${when(c.lastUsedAt)}.` : ""}
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
          <div className={styles.actions}>
            <Button variant="ghost" size="sm" onClick={() => setAsking(true)}>
              Disconnect
            </Button>
          </div>
        </div>
      ) : available ? (
        (connect ?? null)
      ) : (
        <p className={styles.quiet}>It isn&apos;t set up on this server.</p>
      )}
      {said && (
        <p className={styles.said} role="status">
          {said}
        </p>
      )}
      <Dialog
        open={asking}
        onClose={() => setAsking(false)}
        title={`Disconnect ${NAME[provider]}?`}
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
          {provider === "google"
            ? "boardofserv asks Google to revoke its access and forgets it here. Your sheets stay as they are."
            : "boardofserv forgets your chat. It sends nothing there again until you link it."}
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
