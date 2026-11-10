import type { AdminSafetyDTO, AuditEntryDTO } from "@/lib/types";

// The admin's safety page with something in every part, for the demo and
// its tests.

const at = (hoursAgo: number) => new Date(Date.UTC(2026, 10, 9, 12) - hoursAgo * 3_600_000).toISOString();

export const DEMO_SAFETY: AdminSafetyDTO = {
  trust: {
    versions: [
      { versionId: "v-yield", agent: "Instant yield helper", version: 2, score: 388, label: "low", top: "2 reports upheld by an admin this month" },
      { versionId: "v-follow", agent: "Enquiry follow-up", version: 2, score: 566, label: "fair", top: "31 of 44 jobs finished in the last 90 days (70%)" },
    ],
    makers: [{ makerId: "u-fast", maker: "@fast_builds", score: 412, label: "low", top: "1 freeze by an admin in the last 90 days" }],
  },
  reppo: {
    on: true,
    today: { credits: 2640, evals: 6 },
    week: { credits: 11440, evals: 26 },
    inFlight: 2,
    queued: 1,
    failedToday: 0,
    paused: null,
    budgetSpent: false,
    settings: { firstJobs: 3, sampleEvery: 10, weeklyPerAgent: 10, dailyCredits: 4400, actionOpinions: true },
    creditsPerEval: 440,
  },
  queue: {
    payments: [],
    disputes: {
      open: [
        {
          id: "d-1",
          kind: "payment",
          installationId: "i-1",
          agentName: "Fabric restock",
          what: "4.00 USDC to Weftworks on 2026-11-08",
          amount: "4000000",
          decimals: 6,
          reason: "wrong_payee",
          reasonWords: "It paid the wrong payee",
          note: "Weftworks moved their account last month. It paid the old one, and they say nothing arrived.",
          status: "open",
          resolution: null,
          refund: "none",
          createdAt: at(3),
          resolvedAt: null,
          renter: "@harbor_tea",
          maker: "@lena_prints",
        },
        {
          id: "d-2",
          kind: "rent",
          installationId: "i-2",
          agentName: "Enquiry follow-up",
          what: "Rent for week 3, paid 2026-11-03",
          amount: "6000000",
          decimals: 6,
          reason: "not_working",
          reasonWords: "The agent didn't work that week",
          note: "Every job that week failed at the first step. It never answered a single enquiry.",
          status: "open",
          resolution: null,
          refund: "none",
          createdAt: at(8),
          resolvedAt: null,
          renter: "@sam_rivera",
          maker: "@lena_prints",
        },
      ],
      waiting: 0,
      ledgerReady: true,
    },
    blocked: [
      { id: "b-1", agentId: "a-follow", agent: "Enquiry follow-up", version: 2, maker: "@lena_prints", score: 38, reason: "It recorded a reply as ready to send without the person's yes, which its purpose says it asks for.", at: at(3) },
    ],
    held: [
      { type: "listing", id: "a-follow", title: "Enquiry follow-up", by: "@lena_prints", reason: "Reppo's quality checks advised against 3 of its recent jobs, so it is off the board until an admin looks." },
      { type: "request", id: "q-held", title: "Find the home address of a customer who left a bad review", by: "@quiet_lane", reason: "It asks for a private person's home address." },
      { type: "offer", id: "o-held", title: 'Restock helper: "Pay a deposit to my other wallet first and I set it up."', by: "@fast_builds", reason: "It asks for a payment outside the site." },
    ],
    reports: [
      { id: "r-1", kind: "agent", target: "Instant yield helper", targetId: "a-yield", reason: "scam", reasonWords: "A scam or fraud", note: "It says it doubles USDC deposits overnight.", by: "@harbor_tea", createdAt: at(2) },
      { id: "r-2", kind: "maker", target: "@fast_builds", targetId: "u-fast", reason: "spam", reasonWords: "Spam", note: "", by: "@lena_prints", createdAt: at(5) },
    ],
  },
  freezes: [
    { id: "f-1", kind: "agent", target: "Instant yield helper", targetId: "a-yield", reason: "Reported as a scam; checking its payouts.", by: "@site_admin", createdAt: at(1), lifted: null },
    { id: "f-2", kind: "renter", target: "@noisy_shop", targetId: "u-noisy", reason: "Sent the same message to 400 people.", by: "@site_admin", createdAt: at(50), lifted: { at: at(26), by: "@site_admin", reason: "Talked it through; one group only now." } },
  ],
  calls: [
    { by: "agents", purpose: "decision", calls: 86, tokens: 151_420, cost: "289000", sitePaid: "289000" },
    { by: "agents", purpose: "guard", calls: 41, tokens: 73_390, cost: "126000", sitePaid: "96000" },
    { by: "agents", purpose: "screen", calls: 12, tokens: 20_160, cost: "33000", sitePaid: "33000" },
    { by: "boardofserv", purpose: "code_review", calls: 9, tokens: 31_850, cost: "54000", sitePaid: "54000" },
    { by: "boardofserv", purpose: "publish_review", calls: 3, tokens: 14_700, cost: "25000", sitePaid: "25000" },
    { by: "boardofserv", purpose: "post_screen", calls: 7, tokens: 6_230, cost: "11000", sitePaid: "11000" },
  ],
  platform: { today: "36000", budget: "2000000" },
  answers: [
    { purpose: "chat", calls: 214, attempts: 217, empty: 2, retried: 3 },
    { purpose: "decision", calls: 86, attempts: 88, empty: 1, retried: 2 },
    { purpose: "guard", calls: 41, attempts: 41, empty: 0, retried: 0 },
    { purpose: "publish_review", calls: 6, attempts: 6, empty: 0, retried: 0 },
    { purpose: "post_screen", calls: 12, attempts: 17, empty: 5, retried: 3 },
  ],
  costs: [
    { installationId: "i-1", name: "Lead follow-up", owner: "harbor_tea", maker: "lena_prints", week: "1820000", sitePaid: "1820000", calls: 412, decimals: 6 },
    { installationId: "i-2", name: "Restock helper", owner: "lena_prints", maker: "lena_prints", week: "640000", sitePaid: "0", calls: 151, decimals: 6 },
  ],
  reviews: [
    {
      versionId: "v-yield",
      agentId: "a-yield",
      name: "Instant yield helper",
      maker: "fast_builds",
      version: 2,
      state: "draft",
      review: {
        status: "blocked",
        by: "serv",
        reviewedAt: at(3),
        findings: [
          { step: "Move the deposit", severity: "blocking", finding: "It tries to reach the network itself instead of through the tools it was given." },
          { step: "Move the deposit", severity: "blocking", finding: "It sends the renter's balance to an address the purpose doesn't need." },
          { step: "Tell the renter", severity: "warning", finding: "It promises a return the agent can't know." },
        ],
      },
    },
    { versionId: "v-restock", agentId: "a-restock", name: "Restock helper", maker: "lena_prints", version: 3, state: "published", review: { status: "passed", by: "serv", reviewedAt: at(30), findings: [] } },
  ],
};

// An installation's audit log, newest first: a run on the renter's yes, a
// block, an ask, a message within its settings, a limit.
const line = (e: Partial<AuditEntryDTO> & Pick<AuditEntryDTO, "id" | "step" | "tool" | "risk" | "outcome">, hoursAgo: number): AuditEntryDTO => ({
  at: at(hoursAgo),
  agent: "Restock helper",
  renter: null,
  what: null,
  guard: null,
  guardReason: null,
  reason: null,
  approvedBy: null,
  cost: "0",
  spent: null,
  decimals: 6,
  ...e,
});

export const DEMO_AUDIT: AuditEntryDTO[] = [
  line({ id: "l-1", step: "Record the order", tool: "sheets.write", risk: "write", outcome: "ran", what: 'Add 1 row to "Orders"?', guard: "allow", guardReason: "It fits what the agent is for.", approvedBy: "renter", cost: "1156" }, 0.2),
  line({ id: "l-2", step: "Pay the supplier", tool: "wallet.pay", risk: "money", outcome: "blocked", what: "Pay 480.00 USDC to 0x9f2c...e41b?", guard: "block", guardReason: "It sends the shop's orders to a supplier it doesn't use.", reason: "It sends the shop's orders to a supplier it doesn't use.", cost: "1203" }, 0.4),
  line({ id: "l-3", step: "Record the order", tool: "sheets.write", risk: "write", outcome: "asked", what: 'Add 1 row to "Orders"?', guard: "ask", guardReason: "This order is larger than usual for this shop.", reason: "Safety check: This order is larger than usual for this shop.", cost: "1188" }, 0.5),
  line({ id: "l-4", step: "Tell the owner", tool: "telegram.send", risk: "outbound", outcome: "ran", what: 'Send you this message? "Linen is down to 4 metres. I ordered 20."', guard: "allow", guardReason: "A note to the shop owner about their own stock.", approvedBy: "rules", cost: "1092" }, 26),
  line({ id: "l-5", step: "Tell the owner", tool: "telegram.send", risk: "outbound", outcome: "stopped", what: 'Send you this message? "Linen is down to 4 metres."', reason: "It reached its limit of 20 messages an hour, so it is paused. Start it again when you're ready." }, 27),
];
