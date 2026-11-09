import type { ApprovalDTO, InstallationDTO, JobDTO, JobSummaryDTO, MakerDashboardDTO, RentalDetailDTO, RentalDTO } from "@/lib/types";

// Sample rentals for /demo?market=rentals and ?market=rental (development
// only): one agent rented and running, with a question waiting and a few
// jobs, and others in each state. Neutral, made-up names and data.

export const DEMO_NOW = new Date("2026-11-12T10:00:00.000Z");
const at = (days: number, hours = 0) => new Date(DEMO_NOW.getTime() + days * 86_400_000 + hours * 3_600_000).toISOString();
const usdc = (whole: number) => String(BigInt(Math.round(whole * 1e6)));

const job = (id: string, status: JobSummaryDTO["status"], started: string, hoursAgo: number, reason: string | null): JobSummaryDTO => ({
  id,
  installationId: "i-1",
  agentName: "Enquiry follow-up",
  status,
  reason,
  started,
  trigger: started === "by hand" ? "manual" : "check",
  createdAt: at(0, -hoursAgo),
  finishedAt: status === "waiting_for_owner" ? null : at(0, -hoursAgo + 0.02),
  costUsd: 0.0031,
  ms: 41_000,
  stepCount: 4,
  mine: true,
});

const JOBS: JobSummaryDTO[] = [
  job("j-1", "waiting_for_owner", "when a new enquiry came in", 1, null),
  job("j-2", "done", "when a new enquiry came in", 20, "It reached the end of its steps."),
  job("j-3", "failed", "by hand", 30, "The Enquiries tab had no column called email."),
];

const APPROVAL: ApprovalDTO = {
  id: "a-1",
  jobId: "j-1",
  installationId: "i-1",
  agentName: "Enquiry follow-up",
  stepTitle: "Ask before sending the reply",
  kind: "ask",
  reason: null,
  question: "Send this reply to Jordan Lee about the spring workshop? \"Thanks for asking. There are four places left on 14 March; the fee is 40 USDC and covers materials.\"",
  options: [
    { label: "Send it", effect: "The reply goes to Jordan Lee." },
    { label: "Don't send", effect: "Nothing is sent; the enquiry stays open in your sheet." },
  ],
  noAnswer: "If you don't answer within a day, nothing is sent.",
  status: "pending",
  answer: null,
  expiresAt: at(1),
  createdAt: at(0, -1),
};

const INSTALLATION: InstallationDTO = {
  id: "i-1",
  agentId: "00000000-0000-4000-8000-000000000003",
  name: "Enquiry follow-up",
  version: 2,
  status: "active",
  pausedReason: null,
  needs: { telegram: true, google: true },
  missing: [],
  timezone: "UTC",
  settings: [{ key: "enquiries", label: "Enquiries sheet", value: "Enquiries", sheet: { title: "Studio bookings", tab: "Enquiries", link: "https://docs.google.com/spreadsheets/d/demo" } }],
  rules: [{ key: "tone", label: "Tone of replies", type: "text", value: "warm and short" }],
  minGapMinutes: 5,
  dailySpendUsd: 1,
  createdAt: at(-3),
  runs: ["Checks for new enquiries every 15 minutes"],
  nextRunAt: at(0, 0.25),
  takesMessages: false,
  checkNote: null,
  memory: [],
  spendTodayUsd: 0.0094,
  recentJobs: JOBS,
  approvals: [APPROVAL],
  safety: {
    tools: [
      { tool: "sheets.read", risk: "read", does: "Read every row of a sheet.", floor: null, asks: false, canRaise: false },
      { tool: "sheets.write", risk: "write", does: "Add rows to a sheet, or replace all of its rows.", floor: null, asks: true, canRaise: true },
      { tool: "telegram.ask", risk: "outbound", does: "Ask the owner a question and wait for the answer (null when none comes).", floor: "Always waits for your answer.", asks: false, canRaise: false },
      { tool: "telegram.send", risk: "outbound", does: "Send the owner a message.", floor: null, asks: false, canRaise: true },
    ],
    autoSpendUsdc: 0,
    maxAutoSpendUsdc: 1000,
  },
  budget: { spentThisWeek: usdc(0.62), spentToday: usdc(0.09), budget: usdc(1), makerDefault: usdc(1), ceiling: usdc(5), free: false, allowance: usdc(0.25), modelShare: true, decimals: 6 },
};

const base = (patch: Partial<RentalDTO> & Pick<RentalDTO, "id" | "name" | "does" | "status">): RentalDTO => ({
  agentId: "00000000-0000-4000-8000-000000000003",
  maker: "lena_k",
  version: 2,
  pausedReason: null,
  weeklyPrice: usdc(9),
  jobFee: usdc(0.25),
  decimals: 6,
  paidUntil: at(4),
  renews: true,
  weeksPaid: 2,
  installationId: "i-1",
  createdAt: at(-10),
  nextRunAt: null,
  waiting: 0,
  offer: null,
  ...patch,
});

export const DEMO_RENTAL: RentalDetailDTO = {
  ...base({ id: "r-1", name: "Enquiry follow-up", does: "Watches a sheet of enquiries, drafts a reply to each new one and asks you before sending it.", status: "active", nextRunAt: at(0, 0.25), waiting: 1, offer: { version: 3, breaking: null } }),
  money: { spentSoFar: usdc(19.25), thisWeek: usdc(9.75), feesHeld: usdc(0.25) },
  installation: INSTALLATION,
};

export const DEMO_RENTALS: RentalDTO[] = [
  DEMO_RENTAL,
  base({ id: "r-2", agentId: "00000000-0000-4000-8000-000000000002", name: "Morning sheet report", does: "Reads a sheet every morning and sends you a short summary of what changed on Telegram.", status: "cancelling", maker: "sam_rivera", weeklyPrice: usdc(4), jobFee: "0", renews: false, paidUntil: at(2), nextRunAt: at(1, -2) }),
  base({ id: "r-3", agentId: "00000000-0000-4000-8000-000000000001", name: "Fabric restock", does: "Checks your stock sheet every morning, compares three suppliers' prices and records an order for anything low.", status: "unpaid", maker: "maya_r", weeklyPrice: usdc(12), jobFee: "0", paidUntil: at(-1), pausedReason: "This week's rent of 12.00 USDC couldn't be paid: your balance is too low. Top up your wallet, then resume it from Rented." }),
  base({ id: "r-4", agentId: "00000000-0000-4000-8000-000000000004", name: "Price watch", does: "Checks a product page every hour and tells you when the price drops below the one you set.", status: "setup", maker: "theo_m", weeklyPrice: "0", jobFee: "0", installationId: null, weeksPaid: 1, paidUntil: at(6) }),
];

export const DEMO_JOB: JobDTO = {
  ...JOBS[0]!,
  viewer: "owner",
  version: 2,
  untrusted: [],
  plan: [
    { id: "read", title: "Read new enquiries", kind: "code" },
    { id: "draft", title: "Draft a reply", kind: "code" },
    { id: "ask", title: "Ask before sending the reply", kind: "action" },
    { id: "send", title: "Send the reply", kind: "action" },
  ],
  steps: [
    { seq: 1, stepId: "read", title: "Read new enquiries", kind: "code", status: "ok", ms: 1800, model: null, costUsd: 0, tools: [{ tool: "sheets.read", failed: false }] },
    { seq: 2, stepId: "draft", title: "Draft a reply", kind: "code", status: "ok", ms: 3900, model: null, costUsd: 0.0031, tools: [] },
    { seq: 3, stepId: "ask", title: "Ask before sending the reply", kind: "action", status: "waiting", ms: 0, model: null, costUsd: 0, tools: [{ tool: "telegram.ask", failed: false }] },
  ],
  approvals: [APPROVAL],
};

// Any other job: the one before, done, with the reply sent.
export const demoJob = (id: string): JobDTO =>
  id === DEMO_JOB.id
    ? DEMO_JOB
    : {
        ...DEMO_JOB,
        ...JOBS.find((j) => j.id === id)!,
        approvals: [],
        steps: [
          ...DEMO_JOB.steps.slice(0, 2),
          { seq: 3, stepId: "ask", title: "Ask before sending the reply", kind: "action", status: "ok", ms: 52_000, model: null, costUsd: 0, tools: [{ tool: "telegram.ask", failed: false }], outcome: "Send it" },
          { seq: 4, stepId: "send", title: "Send the reply", kind: "action", status: "ok", ms: 900, model: null, costUsd: 0, tools: [{ tool: "sheets.write", failed: false }] },
        ],
      };

// The maker's side: Enquiry follow-up on the board, eight weeks of it.
const monday = (weeksAgo: number) => new Date(Date.UTC(2026, 10, 9) - weeksAgo * 7 * 86_400_000).toISOString();
export const DEMO_DASHBOARD: MakerDashboardDTO = {
  stopped: null,
  frozen: null,
  agentId: "00000000-0000-4000-8000-000000000003",
  name: "Enquiry follow-up",
  listing: { weeklyPrice: usdc(9), jobFee: usdc(0.25), decimals: 6, listed: true, version: 2, modelBudget: "1000000", modelBudgetCeiling: "5000000", modelShare: false, screen: "ok", screenReason: null },
  decimals: 6,
  renters: [
    { handle: "jordan_lee", since: at(-10), status: "active", version: 2, weeksPaid: 2 },
    { handle: "ari.studio", since: at(-24), status: "active", version: 1, weeksPaid: 4 },
    { handle: "kofi_m", since: at(-30), status: "unpaid", version: 2, weeksPaid: 4 },
    { handle: "pat_designs", since: at(-41), status: "cancelling", version: 2, weeksPaid: 6 },
    { handle: "rowan_t", since: at(-52), status: "ended", version: 1, weeksPaid: 3 },
  ],
  earnings: [0, 8.1, 8.1, 16.65, 24.98, 33.53, 25.43, 26.1].map((v, i) => ({ week: monday(7 - i), amount: usdc(v) })),
  earnedTotal: usdc(142.99),
  jobs: { done: 212, failed: 9 },
  failures: [
    { step: "Read new enquiries", count: 6 },
    { step: "Send the reply", count: 2 },
    { step: "Before its first step", count: 1 },
  ],
  versions: [
    { number: 2, publishedAt: at(-12), renters: 3, offered: 0 },
    { number: 1, publishedAt: at(-60), renters: 1, offered: 1 },
  ],
  quality: { score: 79, reviewed: 11, minimum: 5, ship: 64, review: 27, block: 9, previous: { version: 1, score: 71, reviewed: 18 } },
  scored: [
    { id: "s-1", at: at(-1), version: 2, score: 91, route: "ship", confidence: "high", reason: "It drafted a reply that matched the enquiry and asked before recording it as ready.", rubric: { scope: 96, safety: 94, correctness: 90, reversibility: 88 } },
    { id: "s-2", at: at(-2), version: 2, score: 64, route: "review", confidence: "medium", reason: "The reply was polite but missed the delivery question the enquiry asked.", rubric: { scope: 80, safety: 90, correctness: 52, reversibility: 85 } },
    { id: "s-3", at: at(-4), version: 2, score: 38, route: "block", confidence: "high", reason: "It recorded a reply as ready to send without the person's yes, which its purpose says it asks for.", rubric: { scope: 60, safety: 30, correctness: 45, reversibility: 40 } },
  ],
};

export const DEMO_RUNS: JobSummaryDTO[] = JOBS.map((j, i) => ({ ...j, reason: null, mine: i === 2 }));
