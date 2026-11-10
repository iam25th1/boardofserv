"use client";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { animate } from "animejs";
import { Button, TextInput, Textarea } from "@/components/ui";
import { formatAmount } from "@/lib/money";
import { REDUCED_MOTION, ease } from "@/lib/motion";
import { CANT_PULL_BACK, DISPUTE_REASON_WORDS, NOTE_MAX, NOTE_MIN, REASONS_FOR, RENT_REFUND, type DisputeReason } from "@/lib/spending/disputeWords";
import type { DisputableDTO, DisputeDTO, ReceiptDTO, SpendingDTO } from "@/lib/types";
import { moneyNote } from "@/lib/moneyWords";
import styles from "./SpendingPanel.module.css";

// What an agent may spend, for its renter: the allowance it pays from
// (topped up from their balance, taken back any time), what it may pay
// without asking now and why (their auto limit or its trust band, the
// stricter), the payees it may pay (each judged by its address, never its
// name, with a warning when the address is high risk), every payment's receipt with its
// transfer on Base, and disputes.

export type PayeeBody = { action: "save"; label: string; address: string } | { action: "remove"; payeeId: string } | { action: "confirm"; payeeId: string; label: string };
export type DisputeList = { disputes: DisputeDTO[]; disputable: DisputableDTO[] };

export interface SpendingApi {
  load: () => Promise<SpendingDTO>;
  allowance: (body: { action: "topup" | "withdraw"; amount: string; key: string }) => Promise<SpendingDTO>;
  payees: (body: PayeeBody) => Promise<SpendingDTO>;
  disputes: () => Promise<DisputeList>;
  dispute: (body: { kind: "payment" | "rent"; id: string; reason: DisputeReason; note: string }) => Promise<DisputeList>;
}

const usdc = (minor: string | bigint, d = 6) => `${formatAmount(BigInt(minor), d)} USDC`;
const short = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const key = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2, 10)}`);

const RECEIPT_STATUS: Record<ReceiptDTO["status"], string> = { held: "held", broadcast: "sending", confirmed: "paid", failed: "failed, nothing paid" };
const DISPUTE_STATUS: Record<DisputeDTO["status"], string> = { open: "waiting for an admin", upheld: "upheld", rejected: "not upheld" };

export function SpendingPanel({ api, disabled }: { api: SpendingApi; disabled?: boolean }) {
  const [data, setData] = useState<SpendingDTO | null>(null);
  const [disputes, setDisputes] = useState<DisputeList | null>(null);
  const [failed, setFailed] = useState(false);
  const [disputing, setDisputing] = useState<{ kind: "payment" | "rent"; id: string; what: string } | null>(null);
  const load = useCallback(async () => {
    try {
      const [s, d] = await Promise.all([api.load(), api.disputes()]);
      setData(s);
      setDisputes(d);
    } catch {
      setFailed(true);
    }
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);
  if (failed && !data) return <p className={styles.quiet}>Its spending couldn&apos;t load. Try again in a moment.</p>;
  if (!data) return null;
  const mine = (d: { installationId: string | null }) => d.installationId === data.installationId;
  const open = disputes ? { disputes: disputes.disputes.filter(mine), disputable: disputes.disputable.filter(mine) } : { disputes: [], disputable: [] };
  const disputable = new Set(open.disputable.map((d) => d.id));
  return (
    <section className={styles.panel} aria-labelledby="spending-h">
      <h2 id="spending-h">Spending</h2>
      <p className={styles.quiet}>{moneyNote(data.money)}</p>
      <Allowance data={data} api={api} disabled={disabled} onChange={setData} />
      <Limit data={data} />
      <Payees data={data} api={api} disabled={disabled} onChange={setData} />
      <Receipts receipts={data.receipts} canDispute={(r) => disputable.has(r.id)} onDispute={(r) => setDisputing({ kind: "payment", id: r.id, what: `${usdc(r.amount, r.decimals)} to ${r.payee.label}` })} />
      <Disputes
        list={open}
        days={data.disputeDays}
        disputing={disputing}
        onPick={setDisputing}
        send={async (body) => {
          setDisputes(await api.dispute(body));
          setDisputing(null);
        }}
      />
    </section>
  );
}

// The allowance: a chalk bar of what it holds against the most it may, and
// top up or take back.
function Allowance({ data, api, disabled, onChange }: { data: SpendingDTO; api: SpendingApi; disabled?: boolean; onChange: (d: SpendingDTO) => void }) {
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const id = useId();
  const fill = useRef<HTMLSpanElement>(null);
  const d = data.decimals;
  const max = BigInt(data.allowance.max);
  const held = BigInt(data.allowance.available) + BigInt(data.allowance.held);
  const share = max === 0n ? 0 : Math.min(1, Number((held * 10_000n) / max) / 10_000);
  useLayoutEffect(() => {
    const el = fill.current;
    if (!el || window.matchMedia(REDUCED_MOTION).matches) return;
    const a = animate(el, { scaleX: { from: 0, to: 1 }, duration: 600, ease: ease.draw });
    return () => {
      a.revert();
    };
  }, [share]);
  const go = async (action: "topup" | "withdraw", value: string) => {
    if (!value.trim()) {
      setSaid({ text: "Write an amount in USDC first.", bad: true });
      return;
    }
    setBusy(action);
    setSaid(null);
    try {
      onChange(await api.allowance({ action, amount: value.trim(), key: key() }));
      setAmount("");
      setSaid({ text: action === "topup" ? "Topped up." : "Back in your balance." });
    } catch (err) {
      setSaid({ text: err instanceof Error ? err.message : "That didn't work. Try again.", bad: true });
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className={styles.block}>
      <h3>Its allowance</h3>
      <p className={styles.big}>
        <strong>{usdc(data.allowance.available, d)}</strong> <span className={styles.kind}>{data.money.test ? `test, on ${data.money.network}` : `on ${data.money.network}`}</span>
      </p>
      {BigInt(data.allowance.held) > 0n && <p className={styles.quiet}>and {usdc(data.allowance.held, d)} held for a payment on its way</p>}
      <div className={styles.meter} role="img" aria-label={`${usdc(held, d)} of the most it may hold, ${usdc(max, d)}`}>
        <span className={styles.track} />
        <span className={styles.fill} ref={fill} style={{ width: `${share * 100}%` }} />
      </div>
      <p className={styles.quiet}>
        It pays only from this, and only saved payees. It stays yours until it pays someone: take it back whenever you like. It may hold up to {usdc(max, d)}; your balance has {usdc(data.balanceAvailable, d)} to top up from.
      </p>
      <div className={styles.row}>
        <label htmlFor={id} className="visually-hidden">
          Amount in USDC
        </label>
        <span className={styles.money}>
          <TextInput id={id} inputMode="decimal" placeholder="10.00" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={disabled || busy !== null} />
          <span aria-hidden="true">USDC</span>
        </span>
        <Button size="sm" onClick={() => void go("topup", amount)} disabled={disabled || busy !== null}>
          {busy === "topup" ? "Topping up..." : "Top up"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void go("withdraw", amount)} disabled={busy !== null || BigInt(data.allowance.available) === 0n}>
          {busy === "withdraw" ? "Taking back..." : "Take back"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void go("withdraw", "all")} disabled={busy !== null || BigInt(data.allowance.available) === 0n}>
          Take it all back
        </Button>
      </div>
      {said && (
        <p className={styles.said} data-bad={said.bad ? "true" : undefined} role={said.bad ? "alert" : "status"}>
          {said.text}
        </p>
      )}
    </div>
  );
}

// What it may pay without asking now, and which limit sets it.
function Limit({ data }: { data: SpendingDTO }) {
  const l = data.limit;
  const d = data.decimals;
  return (
    <div className={styles.block}>
      <h3>Without asking you</h3>
      {data.paused && <p className={styles.alert}>Agent payments are paused on boardofserv for now: {data.paused}</p>}
      {l.stopped && <p className={styles.alert}>{l.stopped} It can&apos;t pay anything now.</p>}
      <p className={styles.big}>
        {BigInt(l.perPayment) === 0n ? (
          <strong>It asks before every payment</strong>
        ) : (
          <>
            <strong>up to {usdc(l.perPayment, d)}</strong> a payment, {usdc(l.perDay, d)} a day
          </>
        )}
      </p>
      <p>{l.why}</p>
      <p className={styles.quiet}>
        {l.why.includes("trust score") ? "" : `${l.band} `}It has paid {usdc(l.paidToday, d)} today. The first payment to a new payee always asks. Change your auto limit under Safety; its trust band changes with its score.
      </p>
      <p className={styles.quiet}>Payments on Base can&apos;t be pulled back once they&apos;re sent.</p>
    </div>
  );
}

function Payees({ data, api, disabled, onChange }: { data: SpendingDTO; api: SpendingApi; disabled?: boolean; onChange: (d: SpendingDTO) => void }) {
  const [label, setLabel] = useState("");
  const [address, setAddress] = useState("");
  const [names, setNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const labelId = useId();
  const addressId = useId();
  const act = async (tag: string, body: PayeeBody, done: string) => {
    setBusy(tag);
    setSaid(null);
    try {
      onChange(await api.payees(body));
      setSaid({ text: done });
      return true;
    } catch (err) {
      setSaid({ text: err instanceof Error ? err.message : "That didn't work. Try again.", bad: true });
      return false;
    } finally {
      setBusy(null);
    }
  };
  const saved = data.payees.filter((p) => p.status === "active");
  const suggested = data.payees.filter((p) => p.status === "suggested");
  return (
    <div className={styles.block}>
      <h3>Who it may pay</h3>
      {saved.length === 0 ? (
        <p className={styles.quiet}>Nobody yet. Save a payee for it to pay: a name and a Base address.</p>
      ) : (
        <ul className={styles.list}>
          {saved.map((p) => (
            <li key={p.id}>
              <span>
                <strong>{p.label}</strong> <span className={styles.mono}>{short(p.address)}</span>
              </span>
              <span className={styles.quiet}>{p.paidBefore ? "paid before" : "not paid yet: its first payment asks you"}</span>
              <Button size="sm" variant="ghost" disabled={disabled || busy !== null} onClick={() => void act(p.id, { action: "remove", payeeId: p.id }, `${p.label} removed: it can't pay them now.`)}>
                Remove
              </Button>
              {p.warning && <Warning text={p.warning} />}
            </li>
          ))}
        </ul>
      )}
      {suggested.length > 0 && (
        <>
          <p className={styles.quiet}>It tried to pay {suggested.length === 1 ? "an address" : "addresses"} you haven&apos;t saved. Nothing was paid. Save one only if you know it.</p>
          <ul className={styles.list}>
            {suggested.map((p) => (
              <li key={p.id}>
                <span className={styles.mono}>{p.address}</span>
                <TextInput aria-label={`A name for ${short(p.address)}`} placeholder="A name for it" value={names[p.id] ?? ""} onChange={(e) => setNames({ ...names, [p.id]: e.target.value })} disabled={disabled || busy !== null} />
                <Button size="sm" variant="ghost" disabled={disabled || busy !== null || !(names[p.id] ?? "").trim()} onClick={() => void act(p.id, { action: "confirm", payeeId: p.id, label: (names[p.id] ?? "").trim() }, "Saved.")}>
                  Save it
                </Button>
                {p.warning && <Warning text={p.warning} />}
              </li>
            ))}
          </ul>
        </>
      )}
      <form
        className={styles.add}
        onSubmit={(e) => {
          e.preventDefault();
          void act("save", { action: "save", label: label.trim(), address: address.trim() }, `${label.trim()} saved.`).then((ok) => {
            if (ok) {
              setLabel("");
              setAddress("");
            }
          });
        }}
      >
        <label htmlFor={labelId}>Name</label>
        <TextInput id={labelId} value={label} maxLength={40} placeholder="Weftworks" onChange={(e) => setLabel(e.target.value)} disabled={disabled || busy !== null} />
        <label htmlFor={addressId}>Base address</label>
        <TextInput id={addressId} value={address} maxLength={42} placeholder="0x..." className={styles.mono} onChange={(e) => setAddress(e.target.value)} disabled={disabled || busy !== null} />
        <Button size="sm" type="submit" disabled={disabled || busy !== null || !label.trim() || !address.trim()}>
          {busy === "save" ? "Saving..." : "Save the payee"}
        </Button>
      </form>
      {said && (
        <p className={styles.said} data-bad={said.bad ? "true" : undefined} role={said.bad ? "alert" : "status"}>
          {said.text}
        </p>
      )}
    </div>
  );
}

// A payee whose address is high risk: said plainly, whatever its name.
function Warning({ text }: { text: string }) {
  return (
    <p className={styles.warning} role="note">
      <strong>Careful:</strong> {text} A payment to this address always asks you first, whatever your limits.
    </p>
  );
}

function Receipts({ receipts, canDispute, onDispute }: { receipts: ReceiptDTO[]; canDispute: (r: ReceiptDTO) => boolean; onDispute: (r: ReceiptDTO) => void }) {
  return (
    <div className={styles.block}>
      <h3>Receipts</h3>
      {receipts.length === 0 ? (
        <p className={styles.quiet}>No payments yet.</p>
      ) : (
        <ol className={styles.receipts}>
          {receipts.map((r) => (
            <li key={r.id} data-status={r.status}>
              <div className={styles.receiptHead}>
                <strong>{usdc(r.amount, r.decimals)}</strong>
                <span>to {r.payee.label}</span>
                <span className={styles.chip}>{RECEIPT_STATUS[r.status]}</span>
                <time className={styles.quiet} dateTime={r.settledAt ?? r.createdAt}>
                  {when(r.settledAt ?? r.createdAt)}
                </time>
              </div>
              <dl className={styles.facts}>
                <div>
                  <dt>To</dt>
                  <dd className={styles.mono}>{r.payee.address}</dd>
                </div>
                {r.memo && (
                  <div>
                    <dt>For</dt>
                    <dd>{r.memo}</dd>
                  </div>
                )}
                <div>
                  <dt>Approved by</dt>
                  <dd>{r.approval.by === "renter" ? `you${r.approval.at ? `, ${when(r.approval.at)}` : ""}` : r.approval.by === "rules" ? "your limits, without asking" : "nobody yet"}</dd>
                </div>
                {r.guard.verdict && (
                  <div>
                    <dt>Safety check</dt>
                    <dd>
                      {r.guard.verdict === "allow" ? "allowed" : r.guard.verdict === "ask" ? "asked you" : r.guard.verdict === "unavailable" ? "couldn't run, so it asked you" : r.guard.verdict}
                      {r.guard.reason ? `: ${r.guard.reason}` : ""}
                    </dd>
                  </div>
                )}
                {r.error && (
                  <div>
                    <dt>What happened</dt>
                    <dd>{r.error}</dd>
                  </div>
                )}
              </dl>
              <div className={styles.row}>
                {r.explorer && (
                  <a href={r.explorer} target="_blank" rel="noopener noreferrer" className={styles.link}>
                    The transfer on {r.network}
                  </a>
                )}
                {canDispute(r) && (
                  <Button size="sm" variant="ghost" onClick={() => onDispute(r)}>
                    Dispute it
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Disputes({
  list,
  days,
  disputing,
  onPick,
  send,
}: {
  list: DisputeList;
  days: number;
  disputing: { kind: "payment" | "rent"; id: string; what: string } | null;
  onPick: (d: { kind: "payment" | "rent"; id: string; what: string } | null) => void;
  send: (body: { kind: "payment" | "rent"; id: string; reason: DisputeReason; note: string }) => Promise<void>;
}) {
  const weeks = list.disputable.filter((d) => d.kind === "rent");
  return (
    <div className={styles.block}>
      <h3>Disputes</h3>
      <p className={styles.quiet}>Something wrong with a payment or a week&apos;s rent? Dispute it within {days} days and an admin looks.</p>
      {list.disputes.length > 0 && (
        <ul className={styles.list}>
          {list.disputes.map((d) => (
            <li key={d.id} className={styles.dispute}>
              <span>
                <strong>{d.what}</strong> <span className={styles.chip}>{DISPUTE_STATUS[d.status]}</span>
              </span>
              <span className={styles.quiet}>
                {d.reasonWords}: &ldquo;{d.note}&rdquo;
              </span>
              {d.resolution && <span>{d.resolution}</span>}
              {d.refund === "done" && <span>Refunded to your balance.</span>}
              {d.refund === "waiting" && <span>The refund is on its way to your balance.</span>}
            </li>
          ))}
        </ul>
      )}
      {weeks.length > 0 && (
        <ul className={styles.list}>
          {weeks.map((w) => (
            <li key={w.id}>
              <span>
                {w.what}, {usdc(w.amount)}
              </span>
              <Button size="sm" variant="ghost" onClick={() => onPick({ kind: "rent", id: w.id, what: w.what })}>
                Dispute this week
              </Button>
            </li>
          ))}
        </ul>
      )}
      {disputing && <DisputeForm key={disputing.id} target={disputing} send={send} cancel={() => onPick(null)} />}
    </div>
  );
}

function DisputeForm({ target, send, cancel }: { target: { kind: "payment" | "rent"; id: string; what: string }; send: (body: { kind: "payment" | "rent"; id: string; reason: DisputeReason; note: string }) => Promise<void>; cancel: () => void }) {
  const reasons = REASONS_FOR[target.kind];
  const [reason, setReason] = useState<DisputeReason>(reasons[0]!);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const noteId = useId();
  const name = useId();
  const form = useRef<HTMLFormElement>(null);
  // Opened from a receipt further up: brought into view.
  useEffect(() => {
    const el = form.current;
    if (!el) return;
    el.scrollIntoView?.({ block: "nearest", behavior: window.matchMedia?.(REDUCED_MOTION).matches ? "auto" : "smooth" });
    el.querySelector<HTMLInputElement>("input[type=radio]:checked")?.focus({ preventScroll: true });
  }, []);
  const ok = note.trim().length >= NOTE_MIN && note.trim().length <= NOTE_MAX;
  return (
    <form
      ref={form}
      className={styles.disputeForm}
      onSubmit={(e) => {
        e.preventDefault();
        if (!ok || busy) return;
        setBusy(true);
        setSaid(null);
        send({ kind: target.kind, id: target.id, reason, note: note.trim() })
          .catch((err: unknown) => setSaid(err instanceof Error ? err.message : "It couldn't be sent. Try again."))
          .finally(() => setBusy(false));
      }}
    >
      <p>
        <strong>Dispute {target.what}</strong>
      </p>
      <p className={styles.plain}>{target.kind === "payment" ? CANT_PULL_BACK : RENT_REFUND}</p>
      <fieldset className={styles.reasons}>
        <legend>What went wrong</legend>
        {reasons.map((r) => (
          <label key={r}>
            <input type="radio" name={name} value={r} checked={reason === r} onChange={() => setReason(r)} /> {DISPUTE_REASON_WORDS[r]}
          </label>
        ))}
      </fieldset>
      <label htmlFor={noteId}>Say what happened</label>
      <Textarea id={noteId} value={note} maxLength={NOTE_MAX} rows={3} onChange={(e) => setNote(e.target.value)} />
      <div className={styles.row}>
        <Button size="sm" type="submit" disabled={!ok || busy}>
          {busy ? "Sending..." : "Send the dispute"}
        </Button>
        <Button size="sm" variant="ghost" type="button" onClick={cancel} disabled={busy}>
          Cancel
        </Button>
      </div>
      {said && (
        <p className={styles.said} data-bad="true" role="alert">
          {said}
        </p>
      )}
    </form>
  );
}
