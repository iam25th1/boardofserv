"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { SkeletonCards } from "@/components/ui";
import { useStaggerIn } from "@/lib/useStaggerIn";
import type { RentalDTO } from "@/lib/types";
import { price } from "./BoardView";
import { day, RENTAL_WORD } from "./RentalView";
import styles from "./Rental.module.css";

// Everything the user rents, newest first and ended ones last: each one's
// state, when it runs next and when it renews or stops.

export function RentalsView({ load }: { load: () => Promise<RentalDTO[]> }) {
  const [list, setList] = useState<RentalDTO[] | null>(null);
  const [failed, setFailed] = useState(false);
  const ref = useStaggerIn<HTMLUListElement>(Boolean(list?.length));
  useEffect(() => {
    load().then(setList, () => setFailed(true));
  }, [load]);
  if (failed) return <p className={styles.quiet}>What you rent could not load. Try again in a moment.</p>;
  if (!list) return <SkeletonCards label="Getting what you rent" count={2} />;
  if (!list.length) {
    return (
      <div className={styles.empty}>
        <p>Nothing rented yet. Agents on the board run for you on your own sheets and Telegram, paid by the week.</p>
        <Link href="/app/board">Find one on the board</Link>
      </div>
    );
  }
  return (
    <ul className={styles.cards} ref={ref}>
      {list.map((r) => (
        <li key={r.id} data-enter>
          <Link href={`/app/rentals/${r.id}`} className={styles.card} data-status={r.status}>
            <div className={styles.cardHead}>
              <strong>{r.name}</strong>
              <span className={styles.status} data-status={r.status}>
                {RENTAL_WORD[r.status]}
              </span>
            </div>
            <p>{r.does}</p>
            <dl className={styles.cardFacts}>
              <div>
                <dt>{r.status === "ended" ? "Ended" : r.status === "unpaid" ? "Due" : r.renews ? "Renews" : "Stops"}</dt>
                <dd>{r.status === "unpaid" ? "now" : day(r.paidUntil)}</dd>
              </div>
              {r.status !== "ended" && (
                <div>
                  <dt>Next run</dt>
                  <dd>{r.nextRunAt ? day(r.nextRunAt) : r.status === "setup" ? "set it up first" : "not scheduled"}</dd>
                </div>
              )}
              {r.waiting > 0 && (
                <div>
                  <dt>Waiting for you</dt>
                  <dd>{r.waiting === 1 ? "1 question" : `${r.waiting} questions`}</dd>
                </div>
              )}
              <div>
                <dt>A week</dt>
                <dd>{BigInt(r.weeklyPrice) === 0n ? "free" : price(r.weeklyPrice, r.decimals)}</dd>
              </div>
            </dl>
          </Link>
        </li>
      ))}
    </ul>
  );
}
