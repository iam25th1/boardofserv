import { BANDS, NEW_BAND, TRUST, type BandLabel } from "./config";

// The trust score itself: a pure function of what happened (the signals),
// so the same signals always give the same score, and every point comes
// with the words that explain it. See config.ts for the weights.

export interface Signals {
  // Finished jobs in the window: done and failed.
  done: number;
  failed: number;
  // Actions the safety check blocked, recent window.
  blocks: number;
  // Reppo: average job score and how many it reviewed; jobs it advised against.
  reppoAvg: number | null;
  reppoReviewed: number;
  reppoBlocks: number;
  // Upheld reports and disputes (recent window), refunds (window).
  reportsUpheld: number;
  disputesUpheld: number;
  refunds: number;
  // Freezes in the window, one on now, a listing on hold now.
  freezes: number;
  frozenNow: boolean;
  heldNow: boolean;
  ageDays: number;
  renewals: number;
  cancellations: number;
  paymentsGood: number;
  paymentsFailed: number;
}

export interface Factor {
  key: string;
  words: string;
  points: number;
  // False for points earned while new: shown, not counted yet.
  counted: boolean;
}

export interface Score {
  score: number;
  label: BandLabel;
  isNew: boolean;
  factors: Factor[];
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function bandOf(score: number, isNew: boolean): { label: BandLabel; perPayment: number; perDay: number } {
  if (isNew) return NEW_BAND;
  let band: (typeof BANDS)[number] = BANDS[0];
  for (const b of BANDS) if (score >= b.from) band = b;
  return band;
}

export function scoreOf(s: Signals): Score {
  const f: Factor[] = [];
  const add = (key: string, points: number, words: string) => {
    if (points !== 0) f.push({ key, points: Math.round(points), words, counted: true });
  };
  const finished = s.done + s.failed;
  if (finished >= TRUST.jobs.MIN_JOBS) {
    const rate = s.done / finished;
    const pts = clamp((rate - TRUST.jobs.TARGET) * 100 * TRUST.jobs.PER_POINT, -TRUST.jobs.DOWN, TRUST.jobs.UP);
    add("jobs", pts, `${s.done} of ${plural(finished, "job")} finished in the last ${TRUST.WINDOW_DAYS} days (${Math.round(rate * 100)}%)`);
  }
  if (s.blocks) add("blocks", Math.max(TRUST.blocks.CAP, s.blocks * TRUST.blocks.EACH), `${plural(s.blocks, "action")} blocked by the safety check this month`);
  if (s.reppoAvg !== null && s.reppoReviewed >= TRUST.reppo.MIN_REVIEWED) {
    const pts = clamp((s.reppoAvg - TRUST.reppo.PIVOT) * TRUST.reppo.PER_POINT, -TRUST.reppo.DOWN, TRUST.reppo.UP);
    add("reppo", pts, `Reppo scored its jobs ${Math.round(s.reppoAvg)} on average (${s.reppoReviewed} reviewed)`);
  }
  if (s.reppoBlocks) add("reppoBlocks", Math.max(TRUST.reppoBlocks.CAP, s.reppoBlocks * TRUST.reppoBlocks.EACH), `${plural(s.reppoBlocks, "job")} Reppo advised against`);
  if (s.reportsUpheld) add("reports", Math.max(TRUST.reports.CAP, s.reportsUpheld * TRUST.reports.EACH), `${plural(s.reportsUpheld, "report")} upheld by an admin this month`);
  if (s.disputesUpheld) add("disputes", Math.max(TRUST.disputes.CAP, s.disputesUpheld * TRUST.disputes.EACH), `${plural(s.disputesUpheld, "dispute")} upheld this month`);
  if (s.refunds) add("refunds", Math.max(TRUST.refunds.CAP, s.refunds * TRUST.refunds.EACH), `${plural(s.refunds, "week")} of rent refunded`);
  if (s.freezes) add("freezes", Math.max(TRUST.freezes.CAP, s.freezes * TRUST.freezes.EACH), `${plural(s.freezes, "freeze")} by an admin in the last ${TRUST.WINDOW_DAYS} days`);
  if (s.frozenNow) add("frozenNow", TRUST.freezes.ACTIVE, "Frozen by an admin now");
  if (s.heldNow) add("heldNow", TRUST.held.NOW, "Its listing is on hold for review");
  if (s.ageDays >= TRUST.age.DAYS_PER_POINT) add("age", Math.min(TRUST.age.CAP, Math.floor(s.ageDays / TRUST.age.DAYS_PER_POINT)), s.ageDays >= 14 ? `${Math.floor(s.ageDays / 7)} weeks on boardofserv` : `${plural(s.ageDays, "day")} on boardofserv`);
  if (s.renewals) add("renewals", Math.min(TRUST.renewals.UP, s.renewals * TRUST.renewals.POINTS), `${plural(s.renewals, "week")} of renewals`);
  if (s.cancellations) add("cancellations", Math.max(TRUST.renewals.DOWN, s.cancellations * TRUST.renewals.CANCEL), `${plural(s.cancellations, "rental")} cancelled`);
  if (s.paymentsGood) add("payments", Math.min(TRUST.payments.UP, s.paymentsGood * TRUST.payments.GOOD), `${plural(s.paymentsGood, "payment")} made without a problem`);
  if (s.paymentsFailed) add("paymentsFailed", Math.max(TRUST.payments.DOWN, s.paymentsFailed * TRUST.payments.FAILED), `${plural(s.paymentsFailed, "payment")} that failed on chain`);

  const isNew = finished < TRUST.NEW_UNTIL_JOBS;
  // New: nothing earned yet, but anything against it counts.
  const counted = isNew ? f.filter((x) => x.points < 0) : f;
  const score = clamp(TRUST.START + counted.reduce((t, x) => t + x.points, 0), TRUST.MIN, TRUST.MAX);
  const factors = f.map((x) => ({ ...x, counted: !isNew || x.points < 0 })).sort((a, b) => Math.abs(b.points) - Math.abs(a.points) || a.key.localeCompare(b.key));
  return { score, label: bandOf(score, isNew).label, isNew, factors };
}
