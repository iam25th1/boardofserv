"use client";
import { useId, useState } from "react";
import Link from "next/link";
import { Button, TextInput } from "@/components/ui";
import { formatAmount, parseAmount } from "@/lib/money";
import type { MakerListingDTO } from "@/lib/types";
import styles from "./ListingPanel.module.css";

// In an agent's builder, once a version is published: its maker puts it on
// the board for rent at a weekly price in USDC, with a fee per job if they
// like, changes the price, or takes it off. Renters pay the week up front;
// the maker gets 90% of each week and each fee.

export interface ListingBody {
  weeklyPrice: string;
  jobFee: string;
  listed: boolean;
  // Each renter's weekly model budget by default (USDC minor units), and
  // whether renters pay their jobs' model cost on top of the fee.
  modelBudget: string;
  modelShare: boolean;
}

const DECIMALS = 6;
const shown = (minor: string) => (BigInt(minor) === 0n ? "" : formatAmount(BigInt(minor), DECIMALS, 0));

export function ListingPanel({ agentId, version, listing, save }: { agentId: string; version: number; listing: MakerListingDTO | null; save: (body: ListingBody) => Promise<unknown> }) {
  const [weekly, setWeekly] = useState(() => (listing ? shown(listing.weeklyPrice) : ""));
  const [fee, setFee] = useState(() => (listing ? shown(listing.jobFee) : ""));
  const [budget, setBudget] = useState(() => formatAmount(BigInt(listing?.modelBudget ?? "1000000"), DECIMALS, 0));
  const [share, setShare] = useState(Boolean(listing?.modelShare));
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const weeklyId = useId();
  const feeId = useId();
  const budgetId = useId();
  const ceiling = BigInt(listing?.modelBudgetCeiling ?? "5000000");
  const listed = Boolean(listing?.listed);

  const read = (text: string) => (text.trim() === "" ? 0n : parseAmount(text, DECIMALS));

  const send = async (on: boolean) => {
    const w = read(weekly);
    const f = read(fee);
    const b = read(budget);
    if (w === null || f === null) {
      setSaid({ text: "Write a price like 4 or 4.50, in USDC, or leave it empty for free.", bad: true });
      return;
    }
    if (b === null || b > ceiling) {
      setSaid({ text: `Write a model budget from 0 to ${formatAmount(ceiling, DECIMALS, 0)} USDC a week.`, bad: true });
      return;
    }
    setBusy(true);
    setSaid(null);
    try {
      await save({ weeklyPrice: w.toString(), jobFee: f.toString(), listed: on, modelBudget: b.toString(), modelShare: share });
      setSaid({ text: on ? (listed ? "Saved. New renters pay the new price; those renting now keep theirs." : "It's on the board.") : "It's off the board. Those renting it now keep it until they cancel." });
    } catch (err) {
      setSaid({ text: err instanceof Error ? err.message : "That didn't save. Try again.", bad: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.panel} aria-labelledby="listing-h">
      <div className={styles.head}>
        <h2 id="listing-h">{listed ? "On the board for rent" : "Put it on the board for rent"}</h2>
        {listing && (
          <span className={styles.links}>
            <Link href={`/app/agents/${agentId}/dashboard`} className={styles.see}>
              Renters and earnings
            </Link>
            {listed && (
              <Link href={`/app/board/agents/${agentId}`} className={styles.see}>
                See its page
              </Link>
            )}
          </span>
        )}
      </div>
      <p className={styles.quiet}>
        Renters get version {listing?.version ?? version} and set it up with their own sheets and Telegram. They pay a week up front from their wallet; you get 90% of
        each week and each fee, and boardofserv keeps 10%.
      </p>
      <div className={styles.fields}>
        <div className={styles.field}>
          <label htmlFor={weeklyId}>
            A week<span className="visually-hidden">, in USDC</span>
          </label>
          <span className={styles.money}>
            <TextInput id={weeklyId} inputMode="decimal" placeholder="free" value={weekly} onChange={(e) => setWeekly(e.target.value)} disabled={busy} />
            <span aria-hidden="true">USDC</span>
          </span>
        </div>
        <div className={styles.field}>
          <label htmlFor={feeId}>
            For each job it finishes (optional)<span className="visually-hidden">, in USDC</span>
          </label>
          <span className={styles.money}>
            <TextInput id={feeId} inputMode="decimal" placeholder="none" value={fee} onChange={(e) => setFee(e.target.value)} disabled={busy} />
            <span aria-hidden="true">USDC</span>
          </span>
        </div>
      </div>
      <p className={styles.quiet}>A job&apos;s fee is set aside before it runs and only taken when it finishes; a job that fails costs the renter nothing.</p>
      <div className={styles.fields}>
        <div className={styles.field}>
          <label htmlFor={budgetId}>
            Model budget a week, for each renter<span className="visually-hidden">, in USDC</span>
          </label>
          <span className={styles.money}>
            <TextInput id={budgetId} inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} disabled={busy} />
            <span aria-hidden="true">USDC</span>
          </span>
        </div>
        <label className={styles.check}>
          <input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} disabled={busy} />
          Renters pay each job&apos;s model cost on top of the fee
        </label>
      </div>
      <p className={styles.quiet}>
        The budget is what its decisions and safety checks may cost each renter in a week before they are asked (at most {formatAmount(ceiling, DECIMALS, 0)} USDC). Without the
        model cost on renters, boardofserv pays it.
      </p>
      <div className={styles.row}>
        <Button size="sm" onClick={() => void send(true)} disabled={busy}>
          {busy ? "Saving..." : listed ? "Save the price" : "Put it on the board"}
        </Button>
        {listed && (
          <Button size="sm" variant="ghost" onClick={() => void send(false)} disabled={busy}>
            Take it off the board
          </Button>
        )}
      </div>
      {said && (
        <p className={styles.said} data-bad={said.bad ? "true" : undefined} role={said.bad ? "alert" : "status"}>
          {said.text}
        </p>
      )}
    </section>
  );
}
