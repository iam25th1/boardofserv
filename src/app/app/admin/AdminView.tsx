"use client";
import { useCallback, useEffect, useState } from "react";
import { Button, SkeletonPanel, TextInput } from "@/components/ui";
import { formatAmount } from "@/lib/money";
import type { AdminDTO, AdminWithdrawalDTO } from "@/lib/types";
import type { useApi } from "@/lib/useApi";
import styles from "./admin.module.css";

// The admin page's body: today's model spend, accounts waiting to get in,
// the books, agents' payments (their switch, today's, reconciliation),
// approvals, unmatched deposits, payout history and the pause switch.

const STATUS_TEXT: Record<AdminWithdrawalDTO["status"], string> = {
  awaiting_approval: "waiting for approval",
  queued: "queued",
  broadcast: "sending",
  paid: "paid",
  reverted: "reverted, given back",
  rejected: "rejected, given back",
  failed: "failed, given back",
};

// Dollars to the cent, or to a hundredth of a cent below one cent.
function usd(n: number): string {
  return n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

// What the admin page asks of the server. The page passes the real calls;
// the development demo passes canned ones.
export type AdminApi = Pick<ReturnType<typeof useApi>, "getAdmin" | "adminPause" | "adminDecide" | "adminAccess" | "adminAgentPayments">;

const PAY_STATUS: Record<AdminDTO["agentPayments"]["recent"][number]["status"], string> = {
  held: "held",
  broadcast: "sending",
  confirmed: "paid",
  failed: "failed, released",
};

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
  if (!data) return <SkeletonPanel label="Getting the books" lines={8} />;

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

  const spent = data.spend.today >= data.spend.limit;
  return (
    <>
      <section className={styles.section} aria-labelledby="spend-h">
        <h2 id="spend-h">Model spend today</h2>
        <p className={styles.spend}>
          <strong>{usd(data.spend.today)}</strong> of {usd(data.spend.limit)}
        </p>
        <p className={styles.quiet}>
          Estimated from the tokens each model reported, at the prices set for it. Own-key use is not counted. The day ends at midnight UTC.
        </p>
        {spent && <p className={styles.alert}>The limit is reached: chat, publishing and helper uses are paused until midnight UTC, except for people using their own SERV key.</p>}
      </section>

      <section className={styles.section} aria-labelledby="support-h">
        <h2 id="support-h">Support messages</h2>
        <p className={styles.quiet}>What people sent @boardofservbot with /support, newest first. Answer them on Telegram or by email.</p>
        {data.support.length === 0 ? (
          <p className={styles.quiet}>None yet.</p>
        ) : (
          <ul className={styles.support}>
            {data.support.map((m) => (
              <li key={m.id}>
                <span className={styles.quiet}>
                  {m.from}, {new Date(m.at).toLocaleString()}
                </span>
                <p>{m.text}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.section} aria-labelledby="fallback-h">
        <h2 id="fallback-h">Code written by SERV</h2>
        <p className={styles.spend}>
          <strong>{data.codeFallbacks.last30Days}</strong> in the last 30 days, {data.codeFallbacks.total} in all
        </p>
        <p className={styles.quiet}>Dolphin writes agents&apos; code steps. When it fails or times out twice on a step, SERV writes that step instead, and still reviews it in a call of its own.</p>
      </section>

      <section className={styles.section} aria-labelledby="access-h">
        <h2 id="access-h">Waiting to get in</h2>
        <p className={styles.quiet}>
          {data.access.inviteOnly
            ? "Invite-only is on: an account sees the waitlist until it is approved here."
            : "Invite-only is off (INVITE_ONLY), so everyone is let in. Accounts still start out waiting."}
        </p>
        {data.access.waiting.length === 0 ? (
          <p className={styles.quiet}>Nobody waiting.</p>
        ) : (
          <ul className={styles.rows}>
            {data.access.waiting.map((u) => (
              <li key={u.id}>
                <span>
                  <strong>@{u.handle}</strong>
                </span>
                {u.email && <span className={styles.mono}>{u.email}</span>}
                <time className={styles.quiet} dateTime={u.joinedAt}>
                  joined {new Date(u.joinedAt).toLocaleString()}
                </time>
                <span className={styles.actions}>
                  <Button size="sm" disabled={busy !== null} onClick={() => void act(u.id, () => api.adminAccess(u.id, "approve"), `@${u.handle} is in.`)}>
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => void act(u.id, () => api.adminAccess(u.id, "reject"), `@${u.handle} was turned away.`)}
                  >
                    Reject
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

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

      <AgentPayments data={data} busy={busy !== null} fmt={fmt} tx={tx} onSwitch={(paused, reason) => void act("agent-pay", () => api.adminAgentPayments(paused, reason), paused ? "Agent payments paused." : "Agent payments are back on.")} />

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

// Agents' payments from the treasury: the site wide switch (with why it is
// off), the treasury against the floor it keeps, today's payments with
// their transfers, and how far reconciliation with the chain has got.
function AgentPayments({ data, busy, fmt, tx, onSwitch }: { data: AdminDTO; busy: boolean; fmt: (units: string, code: string) => string; tx: (hash: string | null) => React.ReactNode; onSwitch: (paused: boolean, reason?: string) => void }) {
  const a = data.agentPayments;
  const [reason, setReason] = useState("");
  const usdc = data.currencies.find((c) => c.code === "USDC");
  const low = usdc?.treasury != null && BigInt(usdc.treasury) < BigInt(a.floor);
  return (
    <section className={styles.section} aria-labelledby="agent-pay-h">
      <div className={styles.titleRow}>
        <h2 id="agent-pay-h">{a.paused ? "Agent payments are paused" : "Agent payments are on"}</h2>
        {a.paused ? (
          <Button size="sm" variant="primary" aria-pressed disabled={busy || a.reconcile.open.length > 0} onClick={() => onSwitch(false)}>
            Turn agent payments on
          </Button>
        ) : (
          <Button size="sm" variant="ghost" aria-pressed={false} disabled={busy} onClick={() => onSwitch(true, reason.trim() || undefined)}>
            Pause agent payments
          </Button>
        )}
      </div>
      {a.paused ? (
        <p className={styles.alert}>{a.paused}</p>
      ) : (
        <label className={styles.quiet}>
          Why, if you pause them (renters read it):{" "}
          <TextInput className={styles.reason} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="Checking the treasury." />
        </label>
      )}
      {a.paused && a.reconcile.open.length > 0 && <p className={styles.quiet}>Look into the open alerts in the safety queue first: they can&apos;t be turned on until then.</p>}
      <p className={styles.spend}>
        <strong>{fmt(a.today.total, "USDC")}</strong> paid today in {a.today.count} {a.today.count === 1 ? "payment" : "payments"}
        {a.today.inFlight > 0 ? `, ${a.today.inFlight} on the way` : ""}
        {a.today.failed > 0 ? `, ${a.today.failed} failed` : ""}
      </p>
      <p className={styles.quiet}>
        The treasury has {usdc?.treasury == null ? "an unknown amount" : fmt(usdc.treasury, "USDC")} and keeps at least {fmt(a.floor, "USDC")}: below that, agent payments pause by themselves. The whole site pays at most {fmt(a.siteCap, "USDC")} a day.
      </p>
      {low && <p className={styles.alert}>The treasury is below its floor. Top it up before turning agent payments back on.</p>}
      <h3 className={styles.sub}>Reconciliation</h3>
      <p className={styles.quiet}>
        {a.reconcile.block ? `Checked against the chain up to block ${a.reconcile.block}${a.reconcile.at ? `, ${new Date(a.reconcile.at).toLocaleString()}` : ""}.` : "Not checked against the chain yet: it starts at the next block once payments run."}{" "}
        {a.reconcile.open.length === 0 ? "Every payment matched its transfer." : `${a.reconcile.open.length} open ${a.reconcile.open.length === 1 ? "alert" : "alerts"}:`}
      </p>
      {a.reconcile.open.length > 0 && (
        <ul className={styles.rows}>
          {a.reconcile.open.map((o) => (
            <li key={o.id}>
              <span>{o.message}</span>
              <time className={styles.quiet} dateTime={o.at}>
                {new Date(o.at).toLocaleString()}
              </time>
            </li>
          ))}
        </ul>
      )}
      <h3 className={styles.sub}>Today&apos;s payments</h3>
      {a.recent.length === 0 ? (
        <p className={styles.quiet}>None yet today.</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Agent</th>
                <th scope="col">Renter</th>
                <th scope="col">To</th>
                <th scope="col">Amount</th>
                <th scope="col">Status</th>
                <th scope="col">Transfer</th>
              </tr>
            </thead>
            <tbody>
              {a.recent.map((p) => (
                <tr key={p.id}>
                  <th scope="row">{p.agent}</th>
                  <td>{p.renter}</td>
                  <td>{p.payee}</td>
                  <td>{fmt(p.amount, "USDC")}</td>
                  <td>{PAY_STATUS[p.status]}</td>
                  <td>{tx(p.txHash) ?? "none"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
