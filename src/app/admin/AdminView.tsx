"use client";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui";
import { formatAmount } from "@/lib/money";
import type { AdminDTO, AdminWithdrawalDTO } from "@/lib/types";
import type { useApi } from "@/lib/useApi";
import styles from "./admin.module.css";

// The admin page's body: the books, approvals, unmatched deposits, payout
// history and the pause switch.

const STATUS_TEXT: Record<AdminWithdrawalDTO["status"], string> = {
  awaiting_approval: "waiting for approval",
  queued: "queued",
  broadcast: "sending",
  paid: "paid",
  reverted: "reverted, given back",
  rejected: "rejected, given back",
  failed: "failed, given back",
};

// What the admin page asks of the server. The page passes the real calls;
// the development demo passes canned ones.
export type AdminApi = Pick<ReturnType<typeof useApi>, "getAdmin" | "adminPause" | "adminDecide">;

export function AdminBody({ api }: { api: AdminApi }) {
  const [data, setData] = useState<AdminDTO | null>(null);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.getAdmin());
    } catch {
      setMissing(true);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (label: string, run: () => Promise<AdminDTO>, done: string) => {
    setBusy(label);
    setSaid(null);
    try {
      setData(await run());
      setSaid(done);
    } catch (err) {
      setSaid(err instanceof Error ? err.message : "That didn't work. Try again.");
    } finally {
      setBusy(null);
    }
  };

  if (missing) return <p className={styles.quiet}>Nothing here.</p>;
  if (!data) return <p className={styles.loading}>getting the books</p>;

  const fmt = (units: string, code: string) => {
    const c = data.currencies.find((x) => x.code === code);
    return `${formatAmount(BigInt(units), c?.decimals ?? 0)} ${code}`;
  };
  const tx = (hash: string | null) =>
    hash ? (
      <a href={`${data.explorer}/tx/${hash}`} target="_blank" rel="noopener noreferrer" className={styles.mono}>
        {hash.slice(0, 10)}...
      </a>
    ) : null;

  return (
    <>
      <p className={styles.quiet}>
        {data.networkLabel} (chain {data.chainId}). Treasury <span className={styles.mono}>{data.treasury ?? "not set"}</span>
      </p>

      <section className={styles.section} aria-labelledby="pause-h">
        <div className={styles.titleRow}>
          <h2 id="pause-h">{data.paused ? "Payouts are paused" : "Payouts are running"}</h2>
          <Button
            size="sm"
            variant={data.paused ? "primary" : "ghost"}
            aria-pressed={data.paused}
            disabled={busy !== null}
            onClick={() => void act("pause", () => api.adminPause(!data.paused), data.paused ? "Payouts resumed." : "Payouts paused.")}
          >
            {data.paused ? "Resume payouts" : "Pause all payouts"}
          </Button>
        </div>
        <p className={styles.quiet}>Paused, nothing is sent, not even a resend. Withdrawals can still be asked for and wait in the queue.</p>
        {data.signer && <p className={styles.alert}>{data.signer}</p>}
        <p className={styles.said} aria-live="polite">
          {said}
        </p>
      </section>

      <section className={styles.section} aria-labelledby="books-h">
        <h2 id="books-h">Treasury and what it owes</h2>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Currency</th>
                <th scope="col">Treasury</th>
                <th scope="col">Owed</th>
                <th scope="col">Difference</th>
                <th scope="col">Platform fees</th>
              </tr>
            </thead>
            <tbody>
              {data.currencies.map((c) => (
                <tr key={c.code}>
                  <th scope="row">{c.code}</th>
                  <td>{c.treasury === null ? "unknown" : fmt(c.treasury, c.code)}</td>
                  <td>{fmt(c.owed, c.code)}</td>
                  <td data-negative={c.difference !== null && BigInt(c.difference) < 0n ? "true" : undefined}>
                    {c.difference === null ? "unknown" : fmt(c.difference, c.code)}
                  </td>
                  <td>{fmt(c.fees, c.code)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className={styles.quiet}>Owed is every balance plus withdrawals not yet paid out. The difference must never go below zero.</p>
        {data.currencies.some((c) => c.difference !== null && BigInt(c.difference) < 0n) && (
          <p className={styles.alert} role="alert">
            The treasury holds less than it owes. Pause payouts and check the books.
          </p>
        )}
        {data.currencies.map((c) => c.problem && <p key={c.code} className={styles.alert}>{c.problem}</p>)}
      </section>

      <section className={styles.section} aria-labelledby="approvals-h">
        <h2 id="approvals-h">Waiting for approval</h2>
        {data.approvals.length === 0 ? (
          <p className={styles.quiet}>Nothing waiting.</p>
        ) : (
          <ul className={styles.rows}>
            {data.approvals.map((w) => (
              <li key={w.id}>
                <span>
                  <strong>{fmt(w.amount, w.currency)}</strong> for @{w.maker}
                </span>
                <span className={styles.mono}>to {w.to}</span>
                {w.reason && <span className={styles.quiet}>{w.reason}</span>}
                <span className={styles.actions}>
                  <Button size="sm" disabled={busy !== null} onClick={() => void act(w.id, () => api.adminDecide(w.id, "approve"), "Approved: it goes out with the next payout.")}>
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => void act(w.id, () => api.adminDecide(w.id, "reject"), "Rejected: the amount is back in their balance.")}
                  >
                    Reject
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.section} aria-labelledby="unmatched-h">
        <h2 id="unmatched-h">Unmatched deposits</h2>
        <p className={styles.quiet}>Sent from wallets no one has linked. Credited to nobody.</p>
        {data.unmatched.length === 0 ? (
          <p className={styles.quiet}>None.</p>
        ) : (
          <ul className={styles.rows}>
            {data.unmatched.map((d) => (
              <li key={d.id}>
                <strong>{fmt(d.amount, d.currency)}</strong>
                <span className={styles.mono}>from {d.from}</span>
                {tx(d.txHash)}
                <time className={styles.quiet} dateTime={d.seenAt}>
                  {new Date(d.seenAt).toLocaleString()}
                </time>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.section} aria-labelledby="history-h">
        <h2 id="history-h">Payout history</h2>
        {data.history.length === 0 ? (
          <p className={styles.quiet}>No payouts yet.</p>
        ) : (
          <ul className={styles.rows}>
            {data.history.map((w) => (
              <li key={w.id}>
                <span>
                  <strong>{fmt(w.amount, w.currency)}</strong> for @{w.maker}
                </span>
                <span className={styles.status}>
                  {STATUS_TEXT[w.status]}
                  {w.auto ? ", automatic" : ""}
                  {w.nonce !== null ? `, nonce ${w.nonce}` : ""}
                </span>
                {tx(w.txHash)}
                {w.status === "queued" && (
                  <span className={styles.actions}>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() => void act(w.id, () => api.adminDecide(w.id, "reject"), "Cancelled: the amount is back in their balance.")}
                    >
                      Cancel
                    </Button>
                  </span>
                )}
                {w.stuck && (
                  <span className={styles.actions}>
                    <span className={styles.quiet}>Never mined, and its nonce went to another transaction.</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() => void act(w.id, () => api.adminDecide(w.id, "fail"), "Marked failed: the amount is back in their balance.")}
                    >
                      Mark failed
                    </Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
