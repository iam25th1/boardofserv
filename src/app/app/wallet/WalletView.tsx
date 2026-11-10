"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useLinkAccount, usePrivy } from "@privy-io/react-auth";
import { Page } from "@/components/shell/Page";
import { Button, IconButton, SkeletonPanel } from "@/components/ui";
import { CheckIcon, CopyIcon } from "@/components/icons";
import { animateEnter, animateStateChange } from "@/lib/motion";
import { formatAmount, parseAmount } from "@/lib/money";
import { privyAppId } from "@/lib/privy-config";
import type { CurrencyDTO, DepositDTO, PaymentsDTO, WalletDTO, WithdrawalDTO } from "@/lib/types";
import { useApi } from "@/lib/useApi";
import styles from "./wallet.module.css";
import { moneyNote } from "@/lib/moneyWords";

// The wallet: the signed-in user's balances, how to top up, their recent
// deposits, and what they earned from their helpers with a way to withdraw
// it. Topping up is a plain token transfer to the treasury from a linked
// wallet; the server's watcher credits it once it has enough confirmations.
// A withdrawal goes to a linked wallet too.

export interface QrPath {
  size: number;
  d: string;
}

export function WalletView({ payments, qr }: { payments: PaymentsDTO; qr: QrPath | null }) {
  return (
    <Page title="Your wallet" note="top up, pay for helpers, agents and rent, withdraw what you earn">
        {!privyAppId() ? (
          <p className={styles.quiet}>Sign-in isn&apos;t set up here, so there is no wallet yet.</p>
        ) : !payments.enabled ? (
          <p className={styles.quiet}>Payments aren&apos;t set up here yet. Helpers stay free to try.</p>
        ) : (
          <SignedIn payments={payments} qr={qr} />
        )}
    </Page>
  );
}

function SignedIn({ payments, qr }: { payments: PaymentsDTO; qr: QrPath | null }) {
  const { ready, authenticated } = usePrivy();
  if (ready && authenticated) return <Wallet payments={payments} qr={qr} />;
  return (
    <div className={styles.signin}>
      <Link href="/login?next=%2Fapp%2Fwallet" aria-disabled={!ready}>
        Sign in to see your wallet
      </Link>
    </div>
  );
}

export function amountText(units: string, c: Pick<CurrencyDTO, "decimals" | "code">): string {
  return `${formatAmount(BigInt(units), c.decimals)} ${c.code}`;
}

// What the wallet asks of the server. The page passes the real calls; the
// development demo passes canned ones.
export type WalletApi = Pick<ReturnType<typeof useApi>, "getWallet" | "checkDeposits" | "requestWithdrawal">;

const WALLETS_TO_LINK = ["detected_ethereum_wallets", "metamask", "coinbase_wallet", "rainbow", "wallet_connect"] as const;

function Wallet({ payments, qr }: { payments: PaymentsDTO; qr: QrPath | null }) {
  const api = useApi();
  const reload = useRef<() => void>(() => {});
  // Privy links the wallet; loading the wallet again brings our copy in step.
  const { linkWallet } = useLinkAccount({ onSuccess: () => reload.current() });
  return (
    <WalletBody
      payments={payments}
      qr={qr}
      api={api}
      reload={reload}
      onLinkWallet={() => linkWallet({ walletList: [...WALLETS_TO_LINK], walletChainType: "ethereum-only" })}
    />
  );
}

export function WalletBody({
  payments,
  qr,
  api,
  reload,
  onLinkWallet,
}: {
  payments: PaymentsDTO;
  qr: QrPath | null;
  api: WalletApi;
  reload?: { current: () => void };
  onLinkWallet: () => void;
}) {
  const [wallet, setWallet] = useState<WalletDTO | null>(null);
  const [failed, setFailed] = useState(false);
  const [checking, setChecking] = useState(false);
  const [said, setSaid] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setWallet(await api.getWallet());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [api]);

  useEffect(() => {
    void load();
    if (reload) reload.current = () => void load();
  }, [load, reload]);

  const check = async () => {
    setChecking(true);
    setSaid(null);
    const before = new Set(wallet?.deposits.filter((d) => d.status === "credited").map((d) => d.id));
    try {
      const next = await api.checkDeposits();
      setWallet(next);
      const fresh = next.deposits.filter((d) => d.status === "credited" && !before.has(d.id));
      const waiting = next.deposits.filter((d) => d.status === "confirming");
      setSaid(
        fresh.length
          ? `Credited ${fresh.map((d) => amountText(d.amount, currencyOf(payments, d))).join(" and ")}.`
          : waiting.length
            ? `Seen, waiting for ${payments.confirmations} confirmations.`
            : "Nothing new yet. A transfer shows here a few seconds after it lands.",
      );
    } catch (err) {
      setSaid(err instanceof Error ? err.message : "The check failed. Try again.");
    } finally {
      setChecking(false);
    }
  };

  if (failed) {
    return (
      <div className={styles.quiet}>
        <p>Your wallet could not load.</p>
        <Button variant="ghost" size="sm" onClick={() => void load()}>
          Try again
        </Button>
      </div>
    );
  }
  if (!wallet) return <SkeletonPanel label="Getting your wallet" lines={5} />;

  return (
    <>
      <Balances payments={payments} wallet={wallet} />
      <TopUp payments={payments} qr={qr} />
      <section className={styles.section} aria-labelledby="wallets-h">
        <h2 id="wallets-h">Linked wallets</h2>
        <p className={styles.quiet}>Deposits count only from these. Link the wallet you will send from before you send.</p>
        <ul className={styles.wallets}>
          {wallet.wallets.map((w) => (
            <li key={w.address}>
              <code>{w.address}</code>
              <span className={styles.tag}>{w.embedded ? "your boardofserv wallet" : "linked"}</span>
            </li>
          ))}
          {wallet.wallets.length === 0 && <li className={styles.quiet}>None yet.</li>}
        </ul>
        <div className={styles.actions}>
          <Button variant="ghost" size="sm" onClick={onLinkWallet}>
            Link a wallet
          </Button>
        </div>
      </section>
      <Withdraw payments={payments} wallet={wallet} onWallet={setWallet} api={api} />
      <section className={styles.section} aria-labelledby="deposits-h">
        <div className={styles.titleRow}>
          <h2 id="deposits-h">Recent deposits</h2>
          <Button size="sm" onClick={() => void check()} disabled={checking}>
            {checking ? "Checking..." : "Check for my deposit"}
          </Button>
        </div>
        <p className={styles.said} aria-live="polite">
          {said}
        </p>
        <Deposits payments={payments} deposits={wallet.deposits} />
      </section>
    </>
  );
}

function currencyOf(payments: PaymentsDTO, d: { currency: string }): Pick<CurrencyDTO, "decimals" | "code"> {
  return payments.currencies.find((c) => c.code === d.currency) ?? { code: d.currency as CurrencyDTO["code"], decimals: 0 };
}

function Balances({ payments, wallet }: { payments: PaymentsDTO; wallet: WalletDTO }) {
  const money = { network: payments.networkLabel, test: !payments.mainnet };
  return (
    <>
      <section className={styles.balances} aria-label="Balances">
        {wallet.balances.map((b) => (
          <BalanceTile key={b.currency} c={currencyOf(payments, b)} available={b.available} held={b.held} test={money.test} />
        ))}
      </section>
      <p className={styles.moneyNote}>{moneyNote(money)}</p>
    </>
  );
}

function BalanceTile({ c, available, held, test }: { c: Pick<CurrencyDTO, "decimals" | "code">; available: string; held: string; test: boolean }) {
  const value = useRef<HTMLParagraphElement>(null);
  const last = useRef(available);
  // A quiet cue when the balance changes under the user, for example a
  // deposit credited by the check.
  useEffect(() => {
    if (last.current !== available && value.current) animateStateChange(value.current);
    last.current = available;
  }, [available]);
  return (
    <div className={styles.tile}>
      <p className={styles.amount} ref={value}>
        {formatAmount(BigInt(available), c.decimals)}
      </p>
      <p className={styles.code}>{test ? `test ${c.code}` : c.code}</p>
      {BigInt(held) > 0n && <p className={styles.held}>{formatAmount(BigInt(held), c.decimals)} held for a use running now</p>}
    </div>
  );
}

function TopUp({ payments, qr }: { payments: PaymentsDTO; qr: QrPath | null }) {
  const [code, setCode] = useState(payments.currencies[0]?.code);
  const [copied, setCopied] = useState(false);
  const c = payments.currencies.find((x) => x.code === code);
  if (!c || !payments.treasury) return null;
  const treasury = payments.treasury;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(treasury);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section className={styles.section} aria-labelledby="topup-h">
      <h2 id="topup-h">Top up</h2>
      {payments.currencies.length > 1 && (
        <div className={styles.picker} role="radiogroup" aria-label="Currency">
          {payments.currencies.map((x) => (
            <button key={x.code} type="button" role="radio" aria-checked={x.code === code} onClick={() => setCode(x.code)}>
              {x.code}
            </button>
          ))}
        </div>
      )}

      <div className={styles.network}>
        <p className={styles.networkLabel}>Network</p>
        <p className={styles.networkName}>{payments.networkLabel}</p>
        <p className={styles.quiet}>chain id {payments.chainId}</p>
      </div>

      <div className={styles.warning} role="note">
        <p>
          <strong>
            Send only {c.code} on {payments.networkLabel}.
          </strong>{" "}
          Anything sent on another network, or any other token, is lost and can&apos;t be recovered.
        </p>
        <p>Send from a linked wallet. A deposit from any other wallet can&apos;t be matched to you.</p>
      </div>

      <div className={styles.deposit}>
        {qr && (
          <svg className={styles.qr} viewBox={`0 0 ${qr.size} ${qr.size}`} role="img" aria-label="QR code of the deposit address" shapeRendering="crispEdges">
            <path d={qr.d} fill="currentColor" />
          </svg>
        )}
        <div className={styles.addressBox}>
          <p className={styles.networkLabel}>Deposit address</p>
          <code className={styles.address}>{treasury}</code>
          <div className={styles.copyRow}>
            <IconButton label={copied ? "Copied" : "Copy the deposit address"} size="sm" variant="ghost" onClick={() => void copy()}>
              {copied ? <CheckIcon /> : <CopyIcon />}
            </IconButton>
            <span className={styles.quiet} aria-live="polite">
              {copied ? "Copied" : "Copy"}
            </span>
          </div>
          <p className={styles.quiet}>
            {c.code} token: <code>{c.token}</code>
          </p>
          <p className={styles.quiet}>Credited after {payments.confirmations} confirmations.</p>
        </div>
      </div>
    </section>
  );
}

const STATUS_TEXT: Record<DepositDTO["status"], string> = {
  confirming: "confirming",
  credited: "credited",
  dropped: "dropped by the network",
};

function Deposits({ payments, deposits }: { payments: PaymentsDTO; deposits: DepositDTO[] }) {
  const list = useRef<HTMLUListElement>(null);
  const shown = useRef<Set<string> | null>(null);
  // Rows that arrive after the first load are chalked on.
  useEffect(() => {
    const fresh = shown.current ? deposits.filter((d) => !shown.current!.has(d.id)) : [];
    shown.current = new Set(deposits.map((d) => d.id));
    if (fresh.length && list.current) animateEnter(fresh.map((d) => list.current!.querySelector(`[data-id="${d.id}"]`)).filter((el): el is Element => el !== null));
  }, [deposits]);

  if (deposits.length === 0) return <p className={styles.quiet}>No deposits yet.</p>;
  return (
    <ul className={styles.deposits} ref={list}>
      {deposits.map((d) => (
        <li key={d.id} data-id={d.id}>
          <span className={styles.depAmount}>{amountText(d.amount, currencyOf(payments, d))}</span>
          <span className={styles.status} data-state={d.status}>
            <i aria-hidden="true" />
            {STATUS_TEXT[d.status]}
          </span>
          <a href={`${payments.explorer}/tx/${d.txHash}`} target="_blank" rel="noopener noreferrer" className={styles.tx}>
            {d.txHash.slice(0, 10)}...
          </a>
          <time dateTime={d.seenAt} className={styles.quiet}>
            {new Date(d.seenAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
          </time>
        </li>
      ))}
    </ul>
  );
}

const WITHDRAWAL_TEXT: Record<WithdrawalDTO["status"], string> = {
  awaiting_approval: "waiting for approval",
  queued: "queued",
  broadcast: "sending",
  paid: "paid",
  reverted: "reverted, given back",
  rejected: "not approved, given back",
  failed: "failed, given back",
};

const WITHDRAWAL_STATE: Record<WithdrawalDTO["status"], "confirming" | "credited" | "dropped"> = {
  awaiting_approval: "confirming",
  queued: "confirming",
  broadcast: "confirming",
  paid: "credited",
  reverted: "dropped",
  rejected: "dropped",
  failed: "dropped",
};

// Earnings and withdrawals: what the maker earned, and taking money out to a
// linked wallet once the balance passes the currency's minimum.
function Withdraw({ payments, wallet, onWallet, api }: { payments: PaymentsDTO; wallet: WalletDTO; onWallet: (w: WalletDTO) => void; api: WalletApi }) {
  const [code, setCode] = useState(payments.currencies[0]?.code);
  const [amount, setAmount] = useState("");
  const [to, setTo] = useState(wallet.wallets[0]?.address ?? "");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  // One key per withdrawal the user means, so a double submit is one.
  const key = useRef<string>(crypto.randomUUID());
  const c = payments.currencies.find((x) => x.code === code);
  useEffect(() => {
    if (!wallet.wallets.some((w) => w.address === to)) setTo(wallet.wallets[0]?.address ?? "");
  }, [wallet.wallets, to]);
  if (!c) return null;

  const available = BigInt(wallet.balances.find((b) => b.currency === c.code)?.available ?? "0");
  const earned = BigInt(wallet.earned.find((e) => e.currency === c.code)?.amount ?? "0");
  const min = c.withdrawMin === null ? null : BigInt(c.withdrawMin);
  const units = parseAmount(amount, c.decimals);
  const open = min !== null && available >= min;
  const problem =
    min === null
      ? `${c.code} withdrawals aren't open yet.`
      : !open
        ? `You can withdraw once your balance reaches ${formatAmount(min, c.decimals)} ${c.code}.`
        : amount.trim() && units === null
          ? `Write an amount like 12.50, with at most ${c.decimals} decimals.`
          : units !== null && units < min
            ? `The smallest withdrawal is ${formatAmount(min, c.decimals)} ${c.code}.`
            : units !== null && units > available
              ? "That is more than your balance."
              : !to
                ? "Link a wallet to withdraw to."
                : null;
  const ready = open && units !== null && units > 0n && !problem && !busy;

  const submit = async () => {
    if (!ready || units === null) return;
    setBusy(true);
    setSaid(null);
    try {
      onWallet(await api.requestWithdrawal({ currency: c.code, amount: units.toString(), to, key: key.current }));
      key.current = crypto.randomUUID();
      setAmount("");
      setSaid("Withdrawal asked for. Its status is below.");
    } catch (err) {
      setSaid(err instanceof Error ? err.message : "The withdrawal could not be asked for. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const mine = wallet.withdrawals;
  return (
    <section className={styles.section} aria-labelledby="withdraw-h">
      <h2 id="withdraw-h">Earnings and withdrawals</h2>
      {payments.currencies.length > 1 && (
        <div className={styles.picker} role="radiogroup" aria-label="Currency to withdraw">
          {payments.currencies.map((x) => (
            <button key={x.code} type="button" role="radio" aria-checked={x.code === code} onClick={() => setCode(x.code)}>
              {x.code}
            </button>
          ))}
        </div>
      )}
      <dl className={styles.figures}>
        <div>
          <dt>Earned from your helpers and agents</dt>
          <dd>{amountText(earned.toString(), c)}</dd>
        </div>
        <div>
          <dt>Available to withdraw</dt>
          <dd>{amountText(available.toString(), c)}</dd>
        </div>
      </dl>
      <form
        className={styles.withdraw}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className={styles.field}>
          <span>Amount</span>
          <span className={styles.amountRow}>
            <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0.00" disabled={!open || busy} aria-describedby="withdraw-note" />
            <span aria-hidden="true">{c.code}</span>
          </span>
        </label>
        <label className={styles.field}>
          <span>To</span>
          <select value={to} onChange={(e) => setTo(e.target.value)} disabled={!open || busy || wallet.wallets.length === 0}>
            {wallet.wallets.map((w) => (
              <option key={w.address} value={w.address}>
                {w.address}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" disabled={!ready}>
          {busy ? "Asking..." : "Withdraw"}
        </Button>
      </form>
      <p id="withdraw-note" className={styles.said} aria-live="polite">
        {said ?? problem ?? `Sent on ${payments.networkLabel}. Larger withdrawals wait for an admin to approve them.`}
      </p>
      {mine.length > 0 && (
        <ul className={styles.deposits}>
          {mine.map((w) => (
            <li key={w.id}>
              <span className={styles.depAmount}>{amountText(w.amount, currencyOf(payments, w))}</span>
              <span className={styles.status} data-state={WITHDRAWAL_STATE[w.status]}>
                <i aria-hidden="true" />
                {WITHDRAWAL_TEXT[w.status]}
              </span>
              {w.txHash ? (
                <a href={`${payments.explorer}/tx/${w.txHash}`} target="_blank" rel="noopener noreferrer" className={styles.tx}>
                  {w.txHash.slice(0, 10)}...
                </a>
              ) : (
                <span className={styles.quiet}>{w.reason ?? `to ${w.to.slice(0, 8)}...`}</span>
              )}
              <time dateTime={w.createdAt} className={styles.quiet}>
                {new Date(w.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
              </time>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
