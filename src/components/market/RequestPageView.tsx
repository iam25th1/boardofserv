"use client";
import { useCallback, useEffect, useId, useState } from "react";
import Link from "next/link";
import { Button, Dialog, SkeletonPanel, TextInput, Textarea } from "@/components/ui";
import { Page } from "@/components/shell/Page";
import { parseAmount } from "@/lib/money";
import type { OfferDTO, RentalDTO, RequestPageDTO } from "@/lib/types";
import { price } from "./BoardView";
import { CONNECT_WORDS, MeToo } from "./RequestsView";
import styles from "./Requests.module.css";

// One request and the agents makers offered for it. The one who asked can
// accept an offer (renting that agent at its price; what happens is said
// before anything is charged) or close the request. A maker can offer one
// of their published agents with a note and a price, change it, or
// withdraw it.

export interface RequestPageApi {
  load: () => Promise<RequestPageDTO | null>;
  signIn?: string;
  meToo?: (on: boolean) => Promise<RequestPageDTO>;
  close?: () => Promise<RequestPageDTO>;
  // The viewer's agents with a published version, to offer.
  myAgents?: () => Promise<{ id: string; name: string; version: number }[]>;
  offer?: (body: { agentId: string; note: string; weeklyPrice: string; jobFee: string }) => Promise<RequestPageDTO>;
  accept?: (offerId: string) => Promise<RentalDTO>;
  withdraw?: (offerId: string) => Promise<void>;
  onRented?: (r: RentalDTO) => void;
}

const STATUS_WORD = { open: "open", accepted: "answered", closed: "closed" } as const;

export function RequestPageView({ id, api }: { id: string; api: RequestPageApi }) {
  const [page, setPage] = useState<RequestPageDTO | null | undefined>(undefined);
  const reload = useCallback(() => api.load().then(setPage), [api]);
  useEffect(() => {
    reload().catch(() => setPage(null));
  }, [reload, id]);
  if (page === undefined) {
    return (
      <Page width="wide">
        <SkeletonPanel label="Getting the request" lines={6} />
      </Page>
    );
  }
  if (page === null) {
    return (
      <Page title="Not on the board">
        <Link href="/app/requests">All requests</Link>
      </Page>
    );
  }
  const r = page.request;
  const myOffer = page.offers.find((o) => o.mine);
  return (
    <Page title={r.need} note={`asked by @${r.by}${r.mine ? " (you)" : ""}`} width="wide" asideSide="right" asideNarrow="below" aside={<Facts page={page} api={api} onChange={setPage} />}>
      {r.detail && <p className={styles.lede}>{r.detail}</p>}
      <MeToo r={r} onToggle={api.meToo ? (on) => api.meToo!(on).then(setPage) : undefined} signIn={api.signIn} />

      <section className={styles.block} aria-labelledby="offers-h">
        <h2 id="offers-h">{page.offers.length ? `Offered (${page.offers.length})` : "Offered"}</h2>
        {page.offers.length ? (
          <ul className={styles.offers}>
            {page.offers.map((o) => (
              <li key={o.id}>
                <OfferCard o={o} page={page} api={api} onChange={reload} />
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.quiet}>No offers yet. {r.status === "open" ? "Makers who have built something like it can offer it here." : ""}</p>
        )}
      </section>

      {r.status === "open" && !r.mine && api.offer && api.myAgents && <OfferForm api={api} current={myOffer} onChange={setPage} />}
      {r.status === "open" && !r.mine && !api.offer && api.signIn && (
        <p className={styles.quiet}>
          Built something that does this? <Link href={api.signIn}>Sign in to offer it</Link>
        </p>
      )}
    </Page>
  );
}

function Facts({ page, api, onChange }: { page: RequestPageDTO; api: RequestPageApi; onChange: (p: RequestPageDTO) => void }) {
  const r = page.request;
  const [busy, setBusy] = useState(false);
  return (
    <div className={styles.facts}>
      <span className={styles.hand}>{STATUS_WORD[r.status]}</span>
      <dl>
        <div>
          <dt>Would pay</dt>
          <dd>{r.budget === null ? "didn't say" : `up to ${price(r.budget, r.decimals)} a week`}</dd>
        </div>
        <div>
          <dt>Connects to</dt>
          <dd>{r.connects.length ? r.connects.map((c) => CONNECT_WORDS[c]).join(", ") : "anything"}</dd>
        </div>
        <div>
          <dt>Asked</dt>
          <dd>{new Date(r.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}</dd>
        </div>
      </dl>
      {r.mine && r.status === "open" && api.close && (
        <Button
          size="sm"
          variant="quiet"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              onChange(await api.close!());
            } finally {
              setBusy(false);
            }
          }}
        >
          Close the request
        </Button>
      )}
      <Link href="/app/requests" className={styles.small}>
        All requests
      </Link>
    </div>
  );
}

function OfferCard({ o, page, api, onChange }: { o: OfferDTO; page: RequestPageDTO; api: RequestPageApi; onChange: () => Promise<void> }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<{ text: string; topUp: boolean } | null>(null);
  const r = page.request;
  const free = BigInt(o.weeklyPrice) === 0n;
  const accept = async () => {
    setBusy(true);
    setRefused(null);
    try {
      const rental = await api.accept!(o.id);
      api.onRented?.(rental);
    } catch (err) {
      setRefused({ text: err instanceof Error ? err.message : "It couldn't be accepted just now. Try again.", topUp: (err as { status?: number }).status === 402 });
      setBusy(false);
    }
  };
  return (
    <article className={styles.offer} data-status={o.status} aria-labelledby={`offer-${o.id}`}>
      <div className={styles.offerHead}>
        <strong id={`offer-${o.id}`}>{o.agent.listed ? <Link href={`/app/board/agents/${o.agent.id}`}>{o.agent.name}</Link> : o.agent.name}</strong>
        <span className={styles.offerPrice}>{free ? "free" : `${price(o.weeklyPrice, o.decimals)} a week`}</span>
      </div>
      <p className={styles.detail}>{o.agent.does}</p>
      {o.note && <blockquote className={styles.note}>{o.note}</blockquote>}
      <div className={styles.meta}>
        <span>
          @{o.maker}
          {o.mine ? " (you)" : ""}, version {o.agent.version}
        </span>
        {o.agent.connects.length > 0 && <span>{o.agent.connects.map((c) => CONNECT_WORDS[c]).join(", ")}</span>}
        {BigInt(o.jobFee) > 0n && <span>plus {price(o.jobFee, o.decimals)} a finished job</span>}
        {o.status === "accepted" && <span className={styles.accepted}>accepted</span>}
      </div>
      <div className={styles.row}>
        {r.mine && r.status === "open" && o.status === "open" && api.accept && (
          <Button size="sm" onClick={() => setAsking(true)}>
            Accept and rent it
          </Button>
        )}
        {o.mine && o.status === "open" && api.withdraw && (
          <Button size="sm" variant="quiet" onClick={() => void api.withdraw!(o.id).then(onChange)}>
            Withdraw the offer
          </Button>
        )}
      </div>
      <Dialog
        open={asking}
        onClose={() => !busy && setAsking(false)}
        title={`Rent ${o.agent.name}`}
        actions={
          <>
            <Button variant="ghost" onClick={() => setAsking(false)} disabled={busy}>
              Not now
            </Button>
            <Button onClick={() => void accept()} disabled={busy}>
              {busy ? "Renting..." : free ? "Rent it" : `Pay ${price(o.weeklyPrice, o.decimals)} and rent it`}
            </Button>
          </>
        }
      >
        <ul className={styles.terms}>
          {free ? (
            <li>It&apos;s free to rent: nothing comes out of your wallet{BigInt(o.jobFee) > 0n ? " but its fee per job" : ""}.</li>
          ) : (
            <li>The first week, {price(o.weeklyPrice, o.decimals)}, comes out of your wallet balance now. After that it renews each week while your balance covers it.</li>
          )}
          {BigInt(o.jobFee) > 0n && <li>Each job it finishes costs {price(o.jobFee, o.decimals)}, given back if the job fails.</li>}
          <li>Cancel any time: it runs to the end of the week you paid for.</li>
          <li>This answers your request. Next you set it up: your answers, your connections, a test run.</li>
        </ul>
        {refused && (
          <p className={styles.said} role="alert">
            {refused.text} {refused.topUp && <Link href="/app/wallet">Top up your wallet</Link>}
          </p>
        )}
      </Dialog>
    </article>
  );
}

function OfferForm({ api, current, onChange }: { api: RequestPageApi; current: OfferDTO | undefined; onChange: (p: RequestPageDTO) => void }) {
  const [agents, setAgents] = useState<{ id: string; name: string; version: number }[] | null>(null);
  const [agentId, setAgentId] = useState(current?.agent.id ?? "");
  const [note, setNote] = useState(current?.note ?? "");
  const [weekly, setWeekly] = useState("");
  const [fee, setFee] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const agentField = useId();
  const noteId = useId();
  const weeklyId = useId();
  const feeId = useId();
  useEffect(() => {
    api.myAgents!().then(
      (a) => {
        setAgents(a);
        setAgentId((x) => x || a[0]?.id || "");
      },
      () => setAgents([]),
    );
  }, [api]);
  if (agents === null) return null;
  if (!agents.length) {
    return (
      <p className={styles.quiet}>
        Built something that does this? Publish a version of it, then offer it here. <Link href="/app/chat">Describe one in the chat</Link>
      </p>
    );
  }
  const send = async () => {
    const w = weekly.trim() ? parseAmount(weekly, 6) : 0n;
    const f = fee.trim() ? parseAmount(fee, 6) : 0n;
    if (w === null || f === null) {
      setSaid({ text: "Write a price like 4 or 4.50, in USDC, or leave it empty for free.", bad: true });
      return;
    }
    setBusy(true);
    setSaid(null);
    try {
      onChange(await api.offer!({ agentId, note, weeklyPrice: w.toString(), jobFee: f.toString() }));
      setSaid({ text: current ? "Your offer is changed." : "Your offer is on the request." });
    } catch (err) {
      setSaid({ text: err instanceof Error ? err.message : "It couldn't be offered. Try again.", bad: true });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className={styles.offerForm}
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <h2>{current ? "Change your offer" : "Offer one of your agents"}</h2>
      <label htmlFor={agentField}>Your agent</label>
      <select id={agentField} className={styles.select} value={agentId} onChange={(e) => setAgentId(e.target.value)}>
        {agents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}, version {a.version}
          </option>
        ))}
      </select>
      <label htmlFor={noteId}>A note to them (optional)</label>
      <Textarea id={noteId} rows={2} maxLength={600} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What it does for this, and anything it can't" />
      <div className={styles.prices}>
        <div>
          <label htmlFor={weeklyId}>
            A week<span className="visually-hidden">, in USDC</span>
          </label>
          <span className={styles.money}>
            <TextInput id={weeklyId} inputMode="decimal" placeholder="free" value={weekly} onChange={(e) => setWeekly(e.target.value)} />
            <span aria-hidden="true">USDC</span>
          </span>
        </div>
        <div>
          <label htmlFor={feeId}>
            Each finished job (optional)<span className="visually-hidden">, in USDC</span>
          </label>
          <span className={styles.money}>
            <TextInput id={feeId} inputMode="decimal" placeholder="none" value={fee} onChange={(e) => setFee(e.target.value)} />
            <span aria-hidden="true">USDC</span>
          </span>
        </div>
      </div>
      <Button type="submit" disabled={busy || !agentId}>
        {busy ? "Offering..." : current ? "Change the offer" : "Offer it"}
      </Button>
      {said && (
        <p className={styles.said} role={said.bad ? "alert" : "status"}>
          {said.text}
        </p>
      )}
    </form>
  );
}
