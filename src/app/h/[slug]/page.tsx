"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePrivy } from "@privy-io/react-auth";
import { Page } from "@/components/shell/Page";
import { Message } from "@/components/chat/Message";
import { Thinking } from "@/components/chat/Thinking";
import { Button, Textarea } from "@/components/ui";
import { privyAppId } from "@/lib/privy-config";
import { formatAmount } from "@/lib/money";
import { fetchHelper, type HelperPage } from "@/lib/publicApi";
import type { BalanceDTO, PriceDTO, PublicHelperDTO, QuotaDTO } from "@/lib/types";
import { useApi } from "@/lib/useApi";
import styles from "./helper.module.css";

// A published helper's page: its name and description, an input with its
// hint, and the answer streamed in with the chalk-dust word effect. Anyone can
// read it; using it needs sign-in. Each use is a fresh single turn.

const PHRASES = ["reading what you gave it", "working on it"];

export default function HelperPageView({ params }: { params: { slug: string } }) {
  const [page, setPage] = useState<HelperPage | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      setPage(await fetchHelper(params.slug));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [params.slug]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Page>
        {failed ? (
          <div className={styles.gone}>
            <p>This helper could not load.</p>
            <Button variant="ghost" size="sm" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        ) : page === null ? (
          <p className={styles.loading}>getting the helper</p>
        ) : "missing" in page ? (
          <div className={styles.gone}>
            <h1>Nothing on this board</h1>
            <p className={styles.note}>no helper goes by that name</p>
            <Link href="/app/board">See the board</Link>
          </div>
        ) : "takenDown" in page ? (
          <div className={styles.gone}>
            <h1>{page.takenDown}</h1>
            <p>This helper was taken down.</p>
            <Link href="/app/board">See what else is on the board</Link>
          </div>
        ) : (
          <>
            <header className={styles.head}>
              <h1>{page.helper.name}</h1>
              <p>{page.helper.description}</p>
              <small>by @{page.helper.maker}</small>
            </header>
            {privyAppId() ? (
              <SignedInOrNot
                helper={page.helper}
                // The price changed since the page loaded: show the new one.
                onPrices={(prices) => setPage((p) => (p && "helper" in p ? { helper: { ...p.helper, prices } } : p))}
              />
            ) : (
              <SignedOut helper={page.helper} unset />
            )}
          </>
        )}
    </Page>
  );
}

function SignedInOrNot({ helper, onPrices }: { helper: PublicHelperDTO; onPrices: (prices: PriceDTO[]) => void }) {
  const { ready, authenticated } = usePrivy();
  if (ready && authenticated) return <UsePanel helper={helper} onPrices={onPrices} />;
  return <SignedOut helper={helper} waiting={!ready} />;
}

// The input as signed-out visitors see it: there, but asking them to sign in.
function SignedOut({ helper, unset = false, waiting = false }: { helper: PublicHelperDTO; unset?: boolean; waiting?: boolean }) {
  return (
    <div className={styles.use}>
      <Textarea className={styles.input} placeholder={helper.inputHint} aria-label={`What to give ${helper.name}`} rows={4} disabled />
      <div className={styles.row}>
        {unset ? (
          <p className={styles.quota}>Sign-in isn&apos;t set up here, so helpers can&apos;t be used yet.</p>
        ) : (
          <>
            <Link className={styles.signin} href={`/login?next=${encodeURIComponent(`/h/${helper.slug}`)}`} aria-disabled={waiting}>
              Sign in to use it
            </Link>
            <p className={styles.quota}>{helper.prices.length ? `${priceText(helper.prices)} a use, from your wallet.` : "Free to try, with just your email."}</p>
          </>
        )}
      </div>
    </div>
  );
}

// A paid helper's line under the input: the price and, once the wallet has
// loaded (null until then), what is left.
function paidLine(price: PriceDTO | undefined, balance: BalanceDTO | null | undefined): string {
  if (!price) return "";
  const each = `${formatAmount(BigInt(price.amount), price.decimals)} ${price.currency} a use`;
  if (balance === null) return each;
  const left = BigInt(balance?.available ?? "0");
  const line = `${each}, ${formatAmount(left, price.decimals)} ${price.currency} left`;
  return left < BigInt(price.amount) ? `${line}. Not enough for a use.` : line;
}

function quotaLine(q: QuotaDTO | null): string {
  if (!q) return "";
  if (q.remaining > 0) return `${q.remaining} of ${q.limit} uses left today`;
  const at = new Date(q.resetsAt);
  const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const day = at.toDateString() === new Date().toDateString() ? "" : "tomorrow ";
  return `No uses left today. They reset ${day}at ${time}.`;
}

function priceText(prices: PriceDTO[]): string {
  return prices.map((p) => `${formatAmount(BigInt(p.amount), p.decimals)} ${p.currency}`).join(" or ");
}

interface Answer {
  key: string;
  content: string;
  source?: string;
  label?: string;
}

function UsePanel({ helper, onPrices }: { helper: PublicHelperDTO; onPrices: (prices: PriceDTO[]) => void }) {
  const api = useApi();
  const paid = helper.prices.length > 0;
  const [input, setInput] = useState("");
  const [quota, setQuota] = useState<QuotaDTO | null>(null);
  // A paid helper: the user's balances and the one they pay from.
  const [balances, setBalances] = useState<Partial<Record<BalanceDTO["currency"], BalanceDTO>> | null>(null);
  const [pay, setPay] = useState<PriceDTO["currency"]>(helper.prices[0]?.currency ?? "USDC");
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  // Words are gathered and shown once per animation frame, as in the chat.
  const pending = useRef("");
  const frame = useRef<number | null>(null);

  useEffect(() => {
    if (!paid) {
      api.getQuota().then(setQuota, () => setQuota(null));
      return;
    }
    api.getWallet().then(
      (w) => {
        const mine = Object.fromEntries(w.balances.map((b) => [b.currency, b]));
        setBalances(mine);
        // Start on a balance that covers the price, if one does.
        const covers = helper.prices.find((p) => BigInt(mine[p.currency]?.available ?? "0") >= BigInt(p.amount));
        if (covers) setPay(covers.currency);
      },
      () => setBalances({}),
    );
  }, [api, paid, helper.prices]);
  useEffect(() => () => stopRef.current?.(), []);

  const price = helper.prices.find((p) => p.currency === pay);
  const have = balances ? BigInt(balances[pay]?.available ?? "0") : null;
  const short = paid && (!price || have === null || have < BigInt(price.amount));
  const out = paid ? short : quota?.remaining === 0;
  const settle = (e: { quota?: QuotaDTO; balance?: BalanceDTO }) => {
    if (e.quota) setQuota(e.quota);
    const b = e.balance;
    if (b) setBalances((prev) => ({ ...prev, [b.currency]: b }));
  };

  const ask = () => {
    const text = input.trim();
    if (!text || busy || out) return;
    setBusy(true);
    setBlocked(null);
    setError(null);
    let live: Answer = { key: crypto.randomUUID(), content: "" };
    setAnswer(live);
    const drop = () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      const t = pending.current;
      pending.current = "";
      return t;
    };
    const flush = () => {
      const t = drop();
      if (!t) return;
      live = { ...live, content: live.content + t };
      setAnswer(live);
    };
    const end = () => {
      setBusy(false);
      stopRef.current = null;
    };
    stopRef.current = api.runHelper(
      helper.slug,
      text,
      (e) => {
        if (e.type === "meta") {
          live = { ...live, source: e.source, label: e.label };
          setAnswer(live);
        } else if (e.type === "delta") {
          pending.current += e.text;
          if (frame.current === null) frame.current = requestAnimationFrame(flush);
        } else if (e.type === "done") {
          flush();
          settle(e);
          end();
        } else if (e.type === "blocked") {
          // Nothing of the answer stays on the screen.
          drop();
          setAnswer(null);
          setBlocked(e.message);
          settle(e);
          end();
        } else if (e.type === "error") {
          flush();
          if (!live.content) setAnswer(null);
          settle(e);
          if (e.prices) onPrices(e.prices);
          // Out of uses: the line under the input already says when they reset.
          if (e.quota?.remaining !== 0) setError(e.message);
          end();
        }
      },
      paid && price ? { currency: price.currency, price: price.amount } : undefined,
    );
  };

  const stop = () => {
    stopRef.current?.();
    stopRef.current = null;
    setBusy(false);
  };

  return (
    <>
      <form
        className={styles.use}
        onSubmit={(e) => {
          e.preventDefault();
          ask();
        }}
      >
        <Textarea
          className={styles.input}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              ask();
            }
          }}
          placeholder={helper.inputHint}
          aria-label={`What to give ${helper.name}`}
          maxLength={4000}
          rows={4}
        />
        {paid && helper.prices.length > 1 && (
          <div className={styles.pay} role="radiogroup" aria-label="Pay from">
            <span>Pay from</span>
            {helper.prices.map((p) => (
              <button key={p.currency} type="button" role="radio" aria-checked={p.currency === pay} onClick={() => setPay(p.currency)}>
                {p.currency}
              </button>
            ))}
          </div>
        )}
        <div className={styles.row}>
          {busy ? (
            <Button variant="ghost" onClick={stop}>
              Stop
            </Button>
          ) : (
            <Button type="submit" disabled={!input.trim() || out}>
              Ask
            </Button>
          )}
          <p className={styles.quota} aria-live="polite">
            {paid ? paidLine(price, balances ? balances[pay] : null) : quotaLine(quota)}
            {paid && short && balances && (
              <>
                {" "}
                <Link href="/app/wallet">Top up</Link>
              </>
            )}
          </p>
        </div>
      </form>

      <section className={styles.answer} aria-label="Answer" aria-live="polite">
        {busy && answer && !answer.content ? (
          <Thinking phrases={PHRASES} />
        ) : answer?.content ? (
          <Message
            key={answer.key}
            message={{ id: answer.key, role: "assistant", content: answer.content, source: answer.source, sourceLabel: answer.label, settled: !busy }}
            streaming={busy}
          />
        ) : null}
        {blocked && <p className={styles.blocked}>{blocked}</p>}
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </section>
    </>
  );
}
