"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { SkeletonPanel } from "@/components/ui";
import { Page } from "@/components/shell/Page";
import { AgentRuns } from "@/components/agents/AgentRuns";
import type { JobSummaryDTO, MakerDashboardDTO } from "@/lib/types";
import { price } from "./BoardView";
import { EarningsChart } from "./EarningsChart";
import { day, RENTAL_WORD } from "./RentalView";
import styles from "./MakerDashboard.module.css";

// A maker's agent on the board: what it earned them, week by week, who
// rents it, how renters' jobs went in the last 30 days and the steps where
// failing ones failed, its versions and who runs each, and its runs for
// real (renters' without anything of theirs). Beside it: the price and the
// way to change it.

export interface MakerDashboardApi {
  load: () => Promise<MakerDashboardDTO>;
  runs: () => Promise<JobSummaryDTO[]>;
}

export function MakerDashboard({ id, api }: { id: string; api: MakerDashboardApi }) {
  const [data, setData] = useState<MakerDashboardDTO | null | undefined>(undefined);
  useEffect(() => {
    api.load().then(setData, () => setData(null));
  }, [api, id]);
  if (data === undefined) {
    return (
      <Page width="wide">
        <SkeletonPanel label="Getting how it does" lines={8} />
      </Page>
    );
  }
  if (data === null) {
    return (
      <Page title="Nothing here">
        <Link href="/app/agents">Your agents</Link>
      </Page>
    );
  }
  const d = data;
  const renting = d.renters.filter((r) => r.status !== "ended");
  const finished = d.jobs.done + d.jobs.failed;
  const rate = finished ? Math.round((d.jobs.done / finished) * 100) : null;
  return (
    <Page title={d.name} note="on the board" width="wide" asideSide="right" asideNarrow="below" aside={<Side d={d} />}>
      <dl className={styles.stats}>
        <div>
          <dt>Earned so far</dt>
          <dd className={styles.hero}>{price(d.earnedTotal, d.decimals)}</dd>
        </div>
        <div>
          <dt>Renting now</dt>
          <dd>{renting.length}</dd>
        </div>
        <div>
          <dt>Renters&apos; jobs finished, last 30 days</dt>
          <dd>{rate === null ? "none ran yet" : `${rate}% (${d.jobs.done} of ${finished})`}</dd>
        </div>
      </dl>

      <section className={styles.block} aria-labelledby="earned-h">
        <h2 id="earned-h">Earned each week</h2>
        <p className={styles.quiet}>Your 90% of each week&apos;s rent and each fee per job, by the week it was paid.</p>
        <EarningsChart weeks={d.earnings} decimals={d.decimals} />
      </section>

      <section className={styles.block} aria-labelledby="renters-h">
        <h2 id="renters-h">Who rents it</h2>
        {d.renters.length ? (
          <ul className={styles.renters}>
            {d.renters.map((r) => (
              <li key={`${r.handle}-${r.since}`} data-status={r.status}>
                <strong>@{r.handle}</strong>
                <span className={styles.chip} data-status={r.status}>
                  {RENTAL_WORD[r.status]}
                </span>
                <span className={styles.quiet}>
                  version {r.version}, since {day(r.since)}, {r.weeksPaid} {r.weeksPaid === 1 ? "week" : "weeks"} paid
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.quiet}>Nobody yet. {d.listing?.listed ? "It's on the board: renters find it there." : "Put it on the board from its builder."}</p>
        )}
      </section>

      <section className={styles.block} aria-labelledby="fails-h">
        <h2 id="fails-h">Where renters&apos; jobs failed</h2>
        {d.failures.length ? (
          <ol className={styles.fails}>
            {d.failures.map((f) => (
              <li key={f.step}>
                <span>{f.step}</span>
                <span className={styles.meter} aria-hidden="true">
                  <span style={{ width: `${(f.count / d.failures[0]!.count) * 100}%` }} />
                </span>
                <span>
                  {f.count} {f.count === 1 ? "job" : "jobs"}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className={styles.quiet}>No failed jobs in the last 30 days.</p>
        )}
        <p className={styles.quiet}>Counted by the step that failed. What a renter&apos;s job read or wrote stays theirs.</p>
      </section>

      <AgentRuns load={api.runs} />
    </Page>
  );
}

function Side({ d }: { d: MakerDashboardDTO }) {
  const l = d.listing;
  return (
    <div className={styles.side}>
      <div className={styles.priceBox}>
        <span className={styles.hand}>{l?.listed ? "On the board" : "Not on the board"}</span>
        {l && (
          <p className={styles.price}>
            {BigInt(l.weeklyPrice) === 0n ? "Free to rent" : `${price(l.weeklyPrice, l.decimals)} a week`}
            {BigInt(l.jobFee) > 0n && <span className={styles.feeLine}>plus {price(l.jobFee, l.decimals)} a finished job</span>}
          </p>
        )}
        <Link href={`/app/agents/${d.agentId}`}>{l ? "Change the price in its builder" : "Put it on the board from its builder"}</Link>
        {l?.listed && <Link href={`/app/board/agents/${d.agentId}`}>See its page</Link>}
      </div>
      <section aria-labelledby="versions-h" className={styles.versions}>
        <h2 id="versions-h">Versions</h2>
        <ol>
          {d.versions.map((v) => (
            <li key={v.number}>
              <strong>Version {v.number}</strong>
              <span className={styles.quiet}>
                {v.renters} running it{v.offered ? `, offered to ${v.offered}` : ""}
              </span>
            </li>
          ))}
        </ol>
        <p className={styles.quiet}>Publishing a new version offers it to everyone renting: each chooses to update or stay.</p>
      </section>
    </div>
  );
}
