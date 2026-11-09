import type { AdminSafetyDTO } from "@/lib/types";

// The admin's safety page with something in every part, for the demo and
// its tests.

const at = (hoursAgo: number) => new Date(Date.UTC(2026, 10, 9, 12) - hoursAgo * 3_600_000).toISOString();

export const DEMO_SAFETY: AdminSafetyDTO = {
  queue: {
    held: [
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
  costs: [
    { installationId: "i-1", name: "Lead follow-up", owner: "@harbor_tea", maker: "@lena_prints", week: "1820000", sitePaid: "1820000", calls: 412, decimals: 6 },
    { installationId: "i-2", name: "Restock helper", owner: "@lena_prints", maker: "@lena_prints", week: "640000", sitePaid: "0", calls: 151, decimals: 6 },
  ],
  reviews: [
    {
      versionId: "v-yield",
      agentId: "a-yield",
      name: "Instant yield helper",
      maker: "@fast_builds",
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
    { versionId: "v-restock", agentId: "a-restock", name: "Restock helper", maker: "@lena_prints", version: 3, state: "published", review: { status: "passed", by: "serv", reviewedAt: at(30), findings: [] } },
  ],
};
