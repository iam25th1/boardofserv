"use client";
import { useState } from "react";
import Link from "next/link";
import { Button, Dialog } from "@/components/ui";
import type { AgentPageDTO, RentalDTO } from "@/lib/types";
import { price } from "./BoardView";
import styles from "./AgentPage.module.css";

// The way to rent an agent, under its price: sign in first; the maker's
// own agent opens in their builder; one the viewer rents already opens;
// otherwise Rent, which says what happens before anything is charged.

export function RentBox({ page, signedIn, here, rent, onRented }: { page: AgentPageDTO; signedIn: boolean; here: string; rent: () => Promise<RentalDTO>; onRented: (r: RentalDTO) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<{ text: string; topUp: boolean } | null>(null);
  const free = BigInt(page.weeklyPrice) === 0n;
  const fee = BigInt(page.jobFee) > 0n;

  if (page.mine) {
    return (
      <p className={styles.rentNote}>
        It&apos;s yours. <Link href={`/app/agents/${page.id}`}>Open it in your builder</Link>
      </p>
    );
  }
  if (page.rentalId) {
    return (
      <p className={styles.rentNote}>
        You rent it. <Link href={`/app/rentals/${page.rentalId}`}>Open it</Link>
      </p>
    );
  }
  if (!signedIn) {
    return (
      <Link className={styles.rentLink} href={`/login?next=${encodeURIComponent(here)}`}>
        Sign in to rent it
      </Link>
    );
  }

  const go = async () => {
    setBusy(true);
    setRefused(null);
    try {
      onRented(await rent());
    } catch (err) {
      const status = (err as { status?: number }).status;
      setRefused({ text: err instanceof Error ? err.message : "It couldn't be rented just now. Try again.", topUp: status === 402 });
      setBusy(false);
    }
  };

  return (
    <>
      <Button onClick={() => setOpen(true)}>{free ? "Rent it, free" : "Rent it"}</Button>
      <Dialog
        open={open}
        onClose={() => !busy && setOpen(false)}
        title={`Rent ${page.name}`}
        actions={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Not now
            </Button>
            <Button onClick={() => void go()} disabled={busy}>
              {busy ? "Renting..." : free ? "Rent it" : `Pay ${price(page.weeklyPrice, page.decimals)} and rent it`}
            </Button>
          </>
        }
      >
        <ul className={styles.terms}>
          {free ? (
            <li>It&apos;s free to rent: nothing comes out of your wallet{fee ? " but its fee per job" : ""}.</li>
          ) : (
            <li>
              The first week, {price(page.weeklyPrice, page.decimals)}, comes out of your wallet balance now. After that it renews each week while your balance covers it, and pauses
              when it doesn&apos;t.
            </li>
          )}
          {fee && <li>Each job it finishes costs {price(page.jobFee, page.decimals)}, set aside before the job runs and given back if it fails.</li>}
          <li>Cancel any time: it runs to the end of the week you paid for.</li>
          <li>Next you set it up: your answers, your connections, then a test run before it goes live.</li>
        </ul>
        {refused && (
          <p className={styles.refused} role="alert">
            {refused.text} {refused.topUp && <Link href="/app/wallet">Top up your wallet</Link>}
          </p>
        )}
      </Dialog>
    </>
  );
}
