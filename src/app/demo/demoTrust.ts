import type { TrustDTO } from "@/lib/types";
import { bandOf, scoreOf, type Signals } from "@/lib/trust/score";

// Trust scores for the demo, computed by the real formula from made-up
// signals: a strong agent, a fair one, a new one, and a maker.

const none: Signals = {
  done: 0,
  failed: 0,
  blocks: 0,
  reppoAvg: null,
  reppoReviewed: 0,
  reppoBlocks: 0,
  reportsUpheld: 0,
  disputesUpheld: 0,
  refunds: 0,
  freezes: 0,
  frozenNow: false,
  heldNow: false,
  ageDays: 0,
  renewals: 0,
  cancellations: 0,
  paymentsGood: 0,
  paymentsFailed: 0,
};

function trust(s: Partial<Signals>): TrustDTO {
  const t = scoreOf({ ...none, ...s });
  const band = bandOf(t.score, t.isNew);
  return { score: t.score, label: t.label, isNew: t.isNew, factors: t.factors, band: { label: band.label, perPayment: band.perPayment, perDay: band.perDay }, computedAt: "2026-11-10T08:00:00.000Z" };
}

export const TRUST_STRONG = trust({ done: 212, failed: 9, blocks: 1, reppoAvg: 86, reppoReviewed: 24, ageDays: 63, renewals: 14, paymentsGood: 6 });
export const TRUST_FAIR = trust({ done: 31, failed: 13, reppoBlocks: 1, ageDays: 42, renewals: 16 });
export const TRUST_NEW = trust({ done: 3, ageDays: 5 });
export const TRUST_MAKER = trust({ done: 480, failed: 26, reppoAvg: 82, reppoReviewed: 61, reportsUpheld: 1, freezes: 1, blocks: 4, ageDays: 98, renewals: 38, cancellations: 3, paymentsGood: 9 });

// A score a day for the last month, for the trend.
export const trend = (from: number, to: number, days = 30) =>
  Array.from({ length: days }, (_, i) => ({ day: new Date(Date.UTC(2026, 9, 12 + i)).toISOString().slice(0, 10), score: Math.round(from + ((to - from) * i) / (days - 1) + (i % 5 === 2 ? -6 : i % 7 === 4 ? 4 : 0)) }));
