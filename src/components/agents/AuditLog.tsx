"use client";
import { useCallback, useEffect, useState } from "react";
import { Button, SkeletonPanel } from "@/components/ui";
import { formatAmount } from "@/lib/money";
import type { AuditEntryDTO, AuditPageDTO } from "@/lib/types";
import { LevelMark } from "./SafetyPanel";
import styles from "./AuditLog.module.css";

// The audit log of guarded actions, newest first: each thing an agent
// changed, sent or spent (or tried to), what SERV's check said and why,
// who approved it, and what it cost. The same list for the renter (all of
// their own), the maker (every renter, their data hidden) and an admin
// (everything, renters named). Append-only: nothing here can be changed.

export type AuditView = "renter" | "maker" | "admin";

const OUTCOME: Record<AuditEntryDTO["outcome"], Record<AuditView, string>> = {
  ran: { renter: "Done", maker: "Done", admin: "Done" },
  failed: { renter: "Failed", maker: "Failed", admin: "Failed" },
  asked: { renter: "Asked you", maker: "Asked its renter", admin: "Asked its renter" },
  declined: { renter: "Not done: no yes", maker: "Not done: no yes", admin: "Not done: no yes" },
  blocked: { renter: "Blocked", maker: "Blocked", admin: "Blocked" },
  stopped: { renter: "Stopped by a limit", maker: "Stopped by a limit", admin: "Stopped by a limit" },
};

const GUARD: Record<NonNullable<AuditEntryDTO["guard"]>, string> = {
  allow: "SERV's check let it run",
  ask: "SERV's check asked first",
  block: "SERV's check blocked it",
  unavailable: "SERV's check couldn't run, so it asked",
};

function approved(e: AuditEntryDTO, view: AuditView): string | null {
  if (e.outcome !== "ran" && e.outcome !== "failed") return null;
  if (e.approvedBy === "renter") return view === "renter" ? "You said yes" : "Its renter said yes";
  if (e.approvedBy === "rules") return view === "renter" ? "Within your settings: nothing needed asking" : "Within its renter's settings: nothing needed asking";
  return null;
}

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const usdc = (minor: string, d: number) => `${formatAmount(BigInt(minor), d)} USDC`;

export function AuditLog({ load, view, title = "Audit log" }: { load: (before?: string | null) => Promise<AuditPageDTO>; view: AuditView; title?: string }) {
  const [entries, setEntries] = useState<AuditEntryDTO[] | null | undefined>(undefined);
  const [next, setNext] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const first = useCallback(
    () =>
      load().then(
        (p) => {
          setEntries(p.entries);
          setNext(p.next);
        },
        () => setEntries(null),
      ),
    [load],
  );
  useEffect(() => {
    void first();
  }, [first]);
  const older = async () => {
    if (!next) return;
    setBusy(true);
    try {
      const p = await load(next);
      setEntries((e) => [...(e ?? []), ...p.entries]);
      setNext(p.next);
    } catch {
      // The button stays for another try.
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.panel} aria-labelledby="audit-h">
      <h2 id="audit-h">{title}</h2>
      <p className={styles.quiet}>
        {view === "maker"
          ? "Every change, message and payment your agent made or tried, for every renter. What it carried and why stays with each renter."
          : view === "admin"
            ? "Every change, message and payment any agent made or tried."
            : "Every change, message and payment it made or tried for you, what SERV's check said, and who approved it. Nothing here can be edited."}
      </p>
      {entries === undefined ? (
        <SkeletonPanel label="Getting the audit log" lines={3} />
      ) : entries === null ? (
        <p className={styles.quiet}>The audit log could not load. Try again in a moment.</p>
      ) : entries.length === 0 ? (
        <p className={styles.quiet}>Nothing yet: it hasn&apos;t changed, sent or spent anything.</p>
      ) : (
        <ol className={styles.list}>
          {entries.map((e) => (
            <Entry key={e.id} e={e} view={view} />
          ))}
        </ol>
      )}
      {next && (
        <Button variant="ghost" size="sm" onClick={() => void older()} disabled={busy}>
          {busy ? "Getting older ones..." : "Show older"}
        </Button>
      )}
    </section>
  );
}

function Entry({ e, view }: { e: AuditEntryDTO; view: AuditView }) {
  const by = approved(e, view);
  const cost = BigInt(e.cost) > 0n ? `Its check cost ${usdc(e.cost, e.decimals)}` : null;
  return (
    <li data-outcome={e.outcome}>
      <div className={styles.head}>
        <LevelMark risk={e.risk} />
        <strong>{e.step}</strong>
        <span className={styles.chip}>{OUTCOME[e.outcome][view]}</span>
        <time dateTime={e.at} className={styles.when}>
          {when(e.at)}
        </time>
      </div>
      {(view === "admin" || view === "maker") && (
        <p className={styles.who}>
          {e.agent}
          {e.renter ? `, for ${e.renter}` : ""}
        </p>
      )}
      {e.what && <p className={styles.what}>{e.what}</p>}
      {e.guard && (
        <p>
          {GUARD[e.guard]}
          {e.guardReason && e.guard !== "unavailable" ? `: ${e.guardReason}` : "."}
        </p>
      )}
      {e.reason && e.outcome !== "blocked" && <p className={styles.reason}>{e.reason}</p>}
      {(by || cost || e.spent) && (
        <ul className={styles.facts}>
          {by && <li>{by}</li>}
          {e.spent && <li>Spent {Number(e.spent).toFixed(2)} USDC</li>}
          {cost && <li>{cost}</li>}
        </ul>
      )}
    </li>
  );
}
