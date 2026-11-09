"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { createScope, createTimeline, stagger, svg } from "animejs";
import { Button, Dialog, SkeletonPanel } from "@/components/ui";
import { Page } from "@/components/shell/Page";
import { ApprovalCard } from "@/components/agents/ApprovalCard";
import { JobTimeline, dollars } from "@/components/agents/JobTimeline";
import { when } from "@/components/agents/InstallationControls";
import { REDUCED_MOTION, ease } from "@/lib/motion";
import type { JobDTO, JobSummaryDTO, RentalDetailDTO, RentalDTO } from "@/lib/types";
import { price } from "./BoardView";
import styles from "./Rental.module.css";

// One agent the user rents, as its renter sees it: where it stands and
// their controls (pause, resume, cancel to the end of the paid week, or
// keep renting after all), the week paid for drawn as a strip that fills
// as the days go, when it runs next, the questions waiting for them, its
// recent jobs with their timelines, and beside it all the money: this
// week's cost, what it has cost so far and when it renews or stops.

export type RentalAction = "pause" | "resume" | "cancel" | "renew";

export interface RentalApi {
  load: () => Promise<RentalDetailDTO>;
  control: (action: RentalAction) => Promise<RentalDetailDTO>;
  // Its installation's own: a job now, or while it is being set up a test
  // run, then live.
  run: (installationId: string, action: "run" | "test" | "golive") => Promise<unknown>;
  job: (id: string) => Promise<JobDTO>;
  answer: (approvalId: string, answer: string) => Promise<void>;
  now?: () => Date;
}

const POLL_MS = 5_000;

export const RENTAL_WORD: Record<RentalDTO["status"], string> = {
  setup: "to set up",
  testing: "being set up",
  active: "running",
  paused: "paused",
  unpaid: "unpaid",
  cancelling: "stops at the week's end",
  ended: "ended",
};

const JOB_WORD: Record<JobSummaryDTO["status"], string> = {
  queued: "waiting to start",
  running: "running",
  waiting_for_owner: "waiting for you",
  done: "done",
  failed: "failed",
  cancelled: "stopped",
};

export const day = (iso: string) => new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" }).format(new Date(iso));

export function RentalView({ id, api }: { id: string; api: RentalApi }) {
  const [data, setData] = useState<RentalDetailDTO | null | undefined>(undefined);
  const refresh = useCallback(() => api.load().then(setData), [api]);
  useEffect(() => {
    refresh().catch(() => setData(null));
    const t = setInterval(() => void refresh().catch(() => undefined), POLL_MS);
    return () => clearInterval(t);
  }, [refresh, id]);

  if (data === undefined) {
    return (
      <Page width="wide">
        <SkeletonPanel label="Getting what you rent" lines={8} />
      </Page>
    );
  }
  if (data === null) {
    return (
      <Page title="Nothing here" note="it may be someone else's">
        <Link href="/app/rentals">Everything you rent</Link>
      </Page>
    );
  }
  const r = data;
  const inst = r.installation;
  // The newest job not waiting on a question opens with its timeline (one
  // that waits is under Waiting for you already).
  const firstShown = inst?.recentJobs.findIndex((j) => j.status !== "waiting_for_owner") ?? -1;
  return (
    <Page title={r.name} note={`from @${r.maker}, version ${r.version}`} width="wide" asideSide="right" asideNarrow="below" aside={<Money r={r} />}>
      <div className={styles.top}>
        <span className={styles.status} data-status={r.status}>
          {RENTAL_WORD[r.status]}
        </span>
        <Controls r={r} api={api} onChange={setData} refresh={refresh} />
      </div>
      <Explain r={r} />
      {r.status !== "ended" && <WeekStrip r={r} now={api.now?.() ?? new Date()} />}

      {inst && (
        <dl className={styles.facts}>
          <div>
            <dt>Next run</dt>
            <dd>{r.status === "active" ? (r.nextRunAt ? when(r.nextRunAt, inst.timezone) : inst.takesMessages ? "when you message it" : "when you run it") : RENTAL_WORD[r.status]}</dd>
          </div>
          <div>
            <dt>Runs</dt>
            <dd>{inst.runs.join("; ")}</dd>
          </div>
          <div>
            <dt>Model spend today</dt>
            <dd>
              {dollars(inst.spendTodayUsd)} of ${inst.dailySpendUsd.toFixed(2)}
            </dd>
          </div>
        </dl>
      )}

      {inst && inst.approvals.length > 0 && (
        <section className={styles.block} aria-labelledby="waiting-h">
          <h2 id="waiting-h">Waiting for you</h2>
          {inst.approvals.map((a) => (
            <ApprovalCard
              key={a.id}
              approval={a}
              onAnswer={async (answer) => {
                await api.answer(a.id, answer);
                await refresh();
              }}
            />
          ))}
        </section>
      )}

      {inst && (
        <section className={styles.block} aria-labelledby="jobs-h">
          <h2 id="jobs-h">Recent jobs</h2>
          {inst.recentJobs.length ? (
            <ol className={styles.jobs}>
              {inst.recentJobs.map((j, i) => (
                <JobRow key={j.id} job={j} api={api} open={i === firstShown} />
              ))}
            </ol>
          ) : (
            <p className={styles.quiet}>None yet. {r.status === "testing" ? "Run a test to see one." : "Its first job shows here when it runs."}</p>
          )}
          <Link className={styles.more} href={`/app/installations/${inst.id}`}>
            Its settings, rules, memory and messages
          </Link>
        </section>
      )}
    </Page>
  );
}

function Explain({ r }: { r: RentalDetailDTO }) {
  if (r.status === "setup") {
    return (
      <p className={styles.explain}>
        It&apos;s yours to set up: your answers, your connections, then a test run. <Link href={`/app/rentals/${r.id}/setup`}>Set it up</Link>
      </p>
    );
  }
  if (r.status === "unpaid") {
    return (
      <p className={styles.reason} role="status">
        {r.pausedReason ?? `This week's rent of ${price(r.weeklyPrice, r.decimals)} couldn't be paid: your balance is too low.`} <Link href="/app/wallet">Top up your wallet</Link>
      </p>
    );
  }
  if (r.status === "cancelling") return <p className={styles.explain}>It keeps running until {day(r.paidUntil)}, then stops. Nothing more is charged.</p>;
  if (r.status === "testing") return <p className={styles.explain}>Run a test: it does everything for real, once. Then make it live and it runs on its own.</p>;
  if (r.status === "paused") return <p className={styles.explain}>{r.pausedReason ?? "Nothing new starts while it's paused. The week still runs."}</p>;
  if (r.status === "ended") return <p className={styles.explain}>This rental has ended. Rent it again from its page on the board.</p>;
  return null;
}

function Controls({ r, api, onChange, refresh }: { r: RentalDetailDTO; api: RentalApi; onChange: (d: RentalDetailDTO) => void; refresh: () => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const act = async (what: string, go: () => Promise<unknown>, done?: string) => {
    if (busy) return;
    setBusy(what);
    setSaid(null);
    try {
      const got = await go();
      if (got && typeof got === "object" && "money" in got) onChange(got as RentalDetailDTO);
      else await refresh();
      if (done) setSaid(done);
    } catch (err) {
      setSaid(err instanceof Error ? err.message : "That didn't work. Try again.");
    } finally {
      setBusy(null);
      setAsking(false);
    }
  };
  const inst = r.installationId;
  if (r.status === "ended") {
    return (
      <Link className={styles.again} href={`/app/board/agents/${r.agentId}`}>
        Rent it again
      </Link>
    );
  }
  return (
    <div className={styles.controls}>
      {r.status === "setup" && <Link href={`/app/rentals/${r.id}/setup`}>Set it up</Link>}
      {r.status === "testing" && inst && (
        <>
          <Button size="sm" onClick={() => void act("test", () => api.run(inst, "test"), "A test run is queued: it does everything for real, once.")} disabled={busy !== null}>
            {busy === "test" ? "Starting..." : "Run a test"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void act("golive", () => api.run(inst, "golive"), "It's live: it runs on its own from now on.")} disabled={busy !== null}>
            {busy === "golive" ? "Going live..." : "Make it live"}
          </Button>
        </>
      )}
      {(r.status === "active" || r.status === "cancelling") && inst && (
        <>
          <Button size="sm" onClick={() => void act("run", () => api.run(inst, "run"), "A job is queued: it starts as soon as it may.")} disabled={busy !== null}>
            {busy === "run" ? "Starting..." : "Run now"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void act("pause", () => api.control("pause"))} disabled={busy !== null}>
            {busy === "pause" ? "Pausing..." : "Pause"}
          </Button>
        </>
      )}
      {(r.status === "paused" || r.status === "unpaid") && (
        <Button size="sm" onClick={() => void act("resume", () => api.control("resume"))} disabled={busy !== null}>
          {busy === "resume" ? "Resuming..." : r.status === "unpaid" ? `Pay ${price(r.weeklyPrice, r.decimals)} and resume` : "Resume"}
        </Button>
      )}
      {r.renews ? (
        <Button size="sm" variant="quiet" onClick={() => setAsking(true)} disabled={busy !== null}>
          Cancel
        </Button>
      ) : (
        <Button size="sm" variant="ghost" onClick={() => void act("renew", () => api.control("renew"), "It renews each week again.")} disabled={busy !== null}>
          {busy === "renew" ? "Saving..." : "Keep renting"}
        </Button>
      )}
      {said && (
        <span className={styles.said} role="status">
          {said}
        </span>
      )}
      <Dialog
        open={asking}
        onClose={() => setAsking(false)}
        title={`Cancel ${r.name}?`}
        actions={
          <>
            <Button variant="ghost" onClick={() => setAsking(false)}>
              Keep it
            </Button>
            <Button onClick={() => void act("cancel", () => api.control("cancel"))} disabled={busy !== null}>
              {busy === "cancel" ? "Cancelling..." : "Cancel it"}
            </Button>
          </>
        }
      >
        <p>
          {r.status === "unpaid"
            ? "This week isn't paid, so it ends now and stops for good. Nothing more is charged."
            : `It keeps running until ${day(r.paidUntil)}, the end of the week you paid for, then stops. Nothing more is charged. You can change your mind before then.`}
        </p>
      </Dialog>
    </div>
  );
}

// The week paid for, as a chalk strip of seven days: the days gone are
// filled, today is marked, and its end says when it renews or stops. Its
// line is drawn once when the page opens.
function WeekStrip({ r, now }: { r: RentalDetailDTO; now: Date }) {
  const ref = useRef<HTMLDivElement>(null);
  const end = new Date(r.paidUntil).getTime();
  const start = end - 7 * 86_400_000;
  const gone = Math.max(0, Math.min(1, (now.getTime() - start) / (end - start)));
  const W = 700;
  useLayoutEffect(() => {
    if (!ref.current) return;
    const scope = createScope({ root: ref, mediaQueries: { reduce: REDUCED_MOTION } }).add((self) => {
      if (self?.matches.reduce) return;
      const drawn = svg.createDrawable("[data-draw]", 0, 0);
      createTimeline({ defaults: { ease: ease.draw } }).add(drawn, { draw: ["0 0", "0 1"], duration: 700, delay: stagger(60) });
    });
    return () => scope.revert();
  }, []);
  const ends = r.status === "unpaid" ? "unpaid" : r.renews ? `renews ${day(r.paidUntil)}` : `stops ${day(r.paidUntil)}`;
  return (
    <div className={styles.week} ref={ref}>
      <div className={styles.weekHead}>
        <span>Week {r.weeksPaid}</span>
        <span>{ends}</span>
      </div>
      <svg className={`${styles.strip} chalky`} viewBox={`0 0 ${W} 40`} preserveAspectRatio="none" role="img" aria-label={`Week ${r.weeksPaid}: ${Math.round(gone * 7)} of 7 days gone, ${ends}`}>
        <path data-draw d={`M2 20 L${W - 2} 20`} className={styles.rail} />
        {Array.from({ length: 8 }, (_, i) => (
          <path key={i} data-draw d={`M${2 + (i * (W - 4)) / 7} 10 L${2 + (i * (W - 4)) / 7} 30`} className={styles.tick} />
        ))}
        {gone > 0 && <path data-draw d={`M2 20 L${2 + gone * (W - 4)} 20`} className={styles.gone} />}
        {r.status !== "unpaid" && gone < 1 && <circle cx={2 + gone * (W - 4)} cy={20} r={6} className={styles.today} />}
      </svg>
    </div>
  );
}

function Money({ r }: { r: RentalDetailDTO }) {
  const free = BigInt(r.weeklyPrice) === 0n;
  return (
    <div className={styles.money}>
      <div className={styles.thisWeek}>
        <span>This week</span>
        <strong>{price(r.money.thisWeek, r.decimals)}</strong>
      </div>
      <dl className={styles.sums}>
        <div>
          <dt>Spent so far</dt>
          <dd>{price(r.money.spentSoFar, r.decimals)}</dd>
        </div>
        {BigInt(r.money.feesHeld) > 0n && (
          <div>
            <dt>Set aside for jobs running now</dt>
            <dd>{price(r.money.feesHeld, r.decimals)}</dd>
          </div>
        )}
        <div>
          <dt>Price</dt>
          <dd>
            {free ? "free" : `${price(r.weeklyPrice, r.decimals)} a week`}
            {BigInt(r.jobFee) > 0n && `, plus ${price(r.jobFee, r.decimals)} a finished job`}
          </dd>
        </div>
        {r.status !== "ended" && (
          <div>
            <dt>{r.status === "unpaid" ? "Due" : r.renews ? "Renews on" : "Stops on"}</dt>
            <dd>{r.status === "unpaid" ? "now, when you resume it" : day(r.paidUntil)}</dd>
          </div>
        )}
      </dl>
      <Link href="/app/wallet" className={styles.wallet}>
        Your wallet
      </Link>
    </div>
  );
}

function JobRow({ job, api, open: openFirst }: { job: JobSummaryDTO; api: RentalApi; open: boolean }) {
  const [open, setOpen] = useState(openFirst);
  const [full, setFull] = useState<JobDTO | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!open || full) return;
    api.job(job.id).then(setFull, () => setFailed(true));
  }, [open, full, api, job.id]);
  return (
    <li className={styles.job} data-status={job.status}>
      <button type="button" className={styles.jobHead} aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={styles.jobWord}>{JOB_WORD[job.status]}</span>
        <span>{job.started}</span>
        <span className={styles.quiet}>{new Date(job.createdAt).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}</span>
      </button>
      {open && (failed ? <p className={styles.quiet}>This job could not load.</p> : full ? <JobTimeline initial={full} api={{ load: () => api.job(job.id), answer: api.answer }} /> : <SkeletonPanel label="Getting the job" lines={3} />)}
    </li>
  );
}
