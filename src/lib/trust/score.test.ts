import { describe, expect, it } from "vitest";
import { BANDS, TRUST } from "./config";
import { bandOf, scoreOf, type Signals } from "./score";

// The trust score's formula: the same signals give the same score, every
// point has its words, a new agent earns nothing yet but loses points, and
// the score stays between 300 and 850.

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

describe("the trust score", () => {
  it("starts every agent at the same score, new", () => {
    expect(scoreOf(none)).toEqual({ score: TRUST.START, label: "new", isNew: true, factors: [] });
  });

  it("adds each factor's points, with words, sorted by how much they move it", () => {
    const s = scoreOf({ ...none, done: 212, failed: 9, blocks: 2, reppoAvg: 84, reppoReviewed: 24, ageDays: 63, renewals: 12, paymentsGood: 6 });
    expect(s.isNew).toBe(false);
    expect(s.factors).toEqual([
      { key: "jobs", words: "212 of 221 jobs finished in the last 90 days (96%)", points: 44, counted: true },
      { key: "blocks", words: "2 actions blocked by the safety check this month", points: -30, counted: true },
      { key: "reppo", words: "Reppo scored its jobs 84 on average (24 reviewed)", points: 28, counted: true },
      { key: "renewals", words: "12 weeks of renewals", points: 24, counted: true },
      { key: "age", words: "9 weeks on boardofserv", points: 21, counted: true },
      { key: "payments", words: "6 payments made without a problem", points: 12, counted: true },
    ]);
    expect(s.score).toBe(600 + 44 - 30 + 28 + 24 + 21 + 12);
    expect(s.label).toBe("good");
    // The same signals, the same score.
    expect(scoreOf({ ...none, done: 212, failed: 9, blocks: 2, reppoAvg: 84, reppoReviewed: 24, ageDays: 63, renewals: 12, paymentsGood: 6 })).toEqual(s);
  });

  it("caps each factor and keeps the score between 300 and 850", () => {
    const worst = scoreOf({ ...none, done: 10, failed: 90, blocks: 50, reppoAvg: 5, reppoReviewed: 40, reppoBlocks: 30, reportsUpheld: 9, disputesUpheld: 9, refunds: 9, freezes: 9, frozenNow: true, heldNow: true, cancellations: 40, paymentsFailed: 20 });
    expect(worst.score).toBe(300);
    expect(worst.label).toBe("low");
    expect(worst.factors.find((f) => f.key === "blocks")!.points).toBe(TRUST.blocks.CAP);
    expect(worst.factors.find((f) => f.key === "jobs")!.points).toBe(-TRUST.jobs.DOWN);
    const best = scoreOf({ ...none, done: 1000, reppoAvg: 100, reppoReviewed: 100, ageDays: 9999, renewals: 999, paymentsGood: 999 });
    // 600 + 60 + 60 + 40 + 60 + 40 = 860, kept at the top of the range.
    expect(best.score).toBe(850);
    expect(best.factors.find((f) => f.key === "age")!.points).toBe(TRUST.age.CAP);
  });

  it("while new, earns nothing yet but loses points, and says which aren't counted", () => {
    const s = scoreOf({ ...none, done: 4, failed: 0, ageDays: 30, blocks: 1 });
    expect(s.isNew).toBe(true);
    expect(s.score).toBe(600 - 15);
    expect(s.factors.find((f) => f.key === "age")).toMatchObject({ points: 10, counted: false });
    expect(s.factors.find((f) => f.key === "blocks")).toMatchObject({ points: -15, counted: true });
  });

  it("needs a few finished jobs before the finish rate counts, and a few Reppo reviews", () => {
    expect(scoreOf({ ...none, done: 0, failed: 4 }).factors).toEqual([]);
    expect(scoreOf({ ...none, done: 30, reppoAvg: 20, reppoReviewed: 2 }).factors.map((f) => f.key)).toEqual(["jobs"]);
  });

  it("sets the spending band from the score, and the new band for a new agent", () => {
    expect(bandOf(300, false)).toMatchObject({ label: "low", perPayment: 0, perDay: 0 });
    expect(bandOf(599, false).label).toBe("fair");
    expect(bandOf(600, false)).toMatchObject({ label: "good", perPayment: 25, perDay: 100 });
    expect(bandOf(850, false).label).toBe("excellent");
    expect(bandOf(820, true)).toMatchObject({ label: "new", perPayment: 5, perDay: 20 });
    // Bands rise with the score and their limits never fall.
    for (let i = 1; i < BANDS.length; i++) {
      expect(BANDS[i]!.from).toBeGreaterThan(BANDS[i - 1]!.from);
      expect(BANDS[i]!.perPayment).toBeGreaterThanOrEqual(BANDS[i - 1]!.perPayment);
    }
  });
});
