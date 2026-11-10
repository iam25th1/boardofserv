// The trust score's weights and bands, in one place. The score is a fixed
// formula over what happened (never a model's opinion): it starts at
// START and each factor below adds or takes away points, within its cap;
// the total is kept between MIN and MAX. Every factor says in plain words
// what it counted, so a score can always be explained.
//
// Scores are kept for each agent version and each maker. A version's
// factors count its own jobs, payments and Reppo scores, plus what is about
// its agent (reports, freezes, holds, age, renewals); a maker's count
// everything about all of their agents, plus their own account.

export const TRUST = {
  // The range, as credit scores have it.
  MIN: 300,
  MAX: 850,
  // Where everything starts.
  START: 600,
  // Until a version (or maker) has this many finished jobs it is "new": it
  // keeps the starting score and only loses points (nothing earned yet).
  NEW_UNTIL_JOBS: 10,
  // Most factors look back this many days.
  WINDOW_DAYS: 90,
  // Blocks, upheld reports and disputes count over a shorter, more recent window.
  RECENT_DAYS: 30,

  // Finished jobs: the share that finished rather than failed, once there
  // are at least MIN_JOBS. Each point of share above (or below) TARGET is
  // PER_POINT points, up to +UP or down to -DOWN.
  jobs: { MIN_JOBS: 5, TARGET: 0.85, PER_POINT: 4, UP: 60, DOWN: 150 },
  // An action the safety check blocked, in the recent window.
  blocks: { EACH: -15, CAP: -120 },
  // Reppo's average job score, once it reviewed MIN_REVIEWED: each point
  // above (or below) PIVOT is PER_POINT points, between -DOWN and +UP.
  reppo: { MIN_REVIEWED: 3, PIVOT: 70, PER_POINT: 2, UP: 60, DOWN: 80 },
  // A job Reppo advised against, in the window.
  reppoBlocks: { EACH: -20, CAP: -100 },
  // A report an admin upheld (hid or froze what it was about), recent window.
  reports: { EACH: -40, CAP: -160 },
  // A renter's dispute of a payment an admin upheld (a payment on chain
  // can't be pulled back), recent window. Upheld rent disputes are refunds.
  disputes: { EACH: -50, CAP: -200 },
  // A week's rent refunded after an upheld dispute, in the window.
  refunds: { EACH: -30, CAP: -120 },
  // A freeze by an admin (lifted or not), in the window; and while one is
  // still on, a further ACTIVE.
  freezes: { EACH: -60, CAP: -180, ACTIVE: -100 },
  // Its listing on hold for review now (the post screen or Reppo's blocks).
  held: { NOW: -40 },
  // Age: a point for every DAYS_PER_POINT days, up to CAP.
  age: { DAYS_PER_POINT: 3, CAP: 40 },
  // Renewals (each week paid after a rental's first) and cancellations, in
  // the window: POINTS each renewal up to UP; each cancellation CANCEL,
  // down to DOWN.
  renewals: { POINTS: 2, UP: 60, CANCEL: -5, DOWN: -60 },
  // Agent payments that went out without a problem, and ones that failed
  // on chain (reverted or stuck), in the window.
  payments: { GOOD: 2, UP: 40, FAILED: -10, DOWN: -50 },
} as const;

// What a score lets an agent pay without asking: per payment and per day,
// in whole USDC. A renter's own auto limit can be lower, never higher; a
// rule's limit, the phase 5 floor and the site's daily cap still apply; the
// strictest wins. A new agent has the NEW band whatever its score.
export const BANDS = [
  { label: "low", from: 300, perPayment: 0, perDay: 0 },
  { label: "fair", from: 500, perPayment: 5, perDay: 20 },
  { label: "good", from: 600, perPayment: 25, perDay: 100 },
  { label: "strong", from: 700, perPayment: 100, perDay: 300 },
  { label: "excellent", from: 780, perPayment: 250, perDay: 1000 },
] as const;
export const NEW_BAND = { label: "new", perPayment: 5, perDay: 20 } as const;

export type BandLabel = (typeof BANDS)[number]["label"] | "new";
