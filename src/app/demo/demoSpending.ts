import type { DisputableDTO, DisputeDTO, ReceiptDTO, SpendingDTO } from "@/lib/types";
import type { DisputeList, SpendingApi } from "@/components/agents/SpendingPanel";
import { TRUST_FAIR } from "./demoTrust";
import { DISPUTE_REASON_WORDS } from "@/lib/spending/disputeWords";
import { FLAG_WORDS } from "@/lib/spending/addressWords";
import { BETA_MONEY } from "@/lib/moneyWords";

// The fabric restock agent's spending for the demo: an allowance, two
// saved payees and one it suggested, receipts (paid, sending and failed),
// its limit (its trust band caps the renter's auto limit) and a dispute.

const at = (hoursAgo: number) => new Date(Date.UTC(2026, 10, 9, 12) - hoursAgo * 3_600_000).toISOString();
const tx = (n: number) => `0x${n.toString(16).padStart(2, "0").repeat(32)}`;
const WEFT = "0xF3fA00a093b023929b8C0C3Af790E0dCaAcFE84b";
const LOOM = "0x8Ba1f109551bD432803012645Ac136ddd64DBA72";

const receipt = (r: Partial<ReceiptDTO> & Pick<ReceiptDTO, "id" | "amount" | "status">): ReceiptDTO => ({
  decimals: 6,
  payee: { label: "Weftworks", address: WEFT },
  agent: "Fabric restock",
  jobId: "j-1",
  memo: null,
  txHash: null,
  explorer: null,
  network: "Base Sepolia",
  guard: { verdict: "allow", reason: "A saved payee, an amount in line with past orders." },
  approval: { by: "rules", question: null, answer: null, at: null },
  error: null,
  createdAt: at(1),
  settledAt: null,
  ...r,
});

const RECEIPTS: ReceiptDTO[] = [
  receipt({ id: "r-4", amount: "1250000", status: "broadcast", memo: "Linen, 5 m", txHash: tx(14), explorer: `https://sepolia.basescan.org/tx/${tx(14)}`, createdAt: at(0.05) }),
  receipt({
    id: "r-3",
    amount: "12000000",
    status: "confirmed",
    memo: "Waxed cotton, 20 m",
    txHash: tx(13),
    explorer: `https://sepolia.basescan.org/tx/${tx(13)}`,
    guard: { verdict: "ask", reason: "Twice its usual order." },
    approval: { by: "renter", question: "Pay 12.00 USDC to Weftworks (0xF3fA...E84b) from its allowance?", answer: "Yes", at: at(5.1) },
    createdAt: at(5.2),
    settledAt: at(5),
  }),
  receipt({ id: "r-2", amount: "4000000", status: "confirmed", memo: "Thread", txHash: tx(12), explorer: `https://sepolia.basescan.org/tx/${tx(12)}`, createdAt: at(30), settledAt: at(29.9) }),
  receipt({ id: "r-1", amount: "3000000", status: "failed", payee: { label: "Loom & Co", address: LOOM }, error: "The transfer reverted on chain, so the 3.00 USDC went back to its allowance.", createdAt: at(52) }),
];

export const DEMO_SPENDING: SpendingDTO = {
  installationId: "i-1",
  agentName: "Fabric restock",
  decimals: 6,
  allowance: { available: "18750000", held: "1250000", max: "100000000" },
  balanceAvailable: "42500000",
  entries: [],
  payees: [
    { id: "p-1", label: "Weftworks", address: WEFT, status: "active", paidBefore: true, createdAt: at(400), warning: null },
    { id: "p-2", label: "Loom & Co", address: LOOM, status: "active", paidBefore: false, createdAt: at(80), warning: null },
    { id: "p-3", label: "0x4b1d...93ac", address: "0x4B1D3a5c7E9f0b2D4f6A8c0E2b4D6f8A0c2E93Ac", status: "suggested", paidBefore: false, createdAt: at(2), warning: FLAG_WORDS.maker_wallet },
  ],
  receipts: RECEIPTS,
  limit: {
    perPayment: "5000000",
    perDay: "20000000",
    paidToday: "13250000",
    why: `You allow 50.00 USDC a payment, but with its trust score of ${TRUST_FAIR.score} (${TRUST_FAIR.label}) it may pay at most 5.00 USDC a payment and 20.00 USDC a day without asking.`,
    band: `With its trust score of ${TRUST_FAIR.score} (${TRUST_FAIR.label}) it may pay up to 5.00 USDC a payment and 20.00 USDC a day without asking.`,
    trust: TRUST_FAIR,
    stopped: null,
  },
  paused: null,
  money: BETA_MONEY,
  disputeDays: 14,
};

const DISPUTES: DisputeDTO[] = [
  {
    id: "d-9",
    kind: "payment",
    installationId: "i-1",
    agentName: "Fabric restock",
    what: "4.00 USDC to Weftworks on 2026-11-08",
    amount: "4000000",
    decimals: 6,
    reason: "not_done",
    reasonWords: "It paid for something that wasn't done",
    note: "The thread order was paid twice: once by hand, once by the agent.",
    status: "upheld",
    resolution: "Upheld: It paid an order the shop had already paid.",
    refund: "none",
    createdAt: at(26),
    resolvedAt: at(20),
  },
];

const DISPUTABLE: DisputableDTO[] = [
  { kind: "payment", installationId: "i-1", id: "r-3", agentName: "Fabric restock", what: "12.00 USDC to Weftworks on 2026-11-09", amount: "12000000", until: at(-330) },
  { kind: "rent", installationId: "i-1", id: "rent-1:3", agentName: "Fabric restock", what: "Rent for week 3, paid 2026-11-03", amount: "6000000", until: at(-190) },
];

export function demoSpendingApi(): SpendingApi {
  let s = DEMO_SPENDING;
  let d: DisputeList = { disputes: DISPUTES, disputable: DISPUTABLE };
  return {
    load: async () => s,
    allowance: async (b) => {
      const n = b.amount === "all" ? BigInt(s.allowance.available) : BigInt(Math.round(Number(b.amount) * 1e6));
      const available = b.action === "topup" ? BigInt(s.allowance.available) + n : BigInt(s.allowance.available) - n;
      s = { ...s, allowance: { ...s.allowance, available: available.toString() } };
      return s;
    },
    payees: async (b) => {
      if (b.action === "remove") s = { ...s, payees: s.payees.filter((p) => p.id !== b.payeeId) };
      else if (b.action === "confirm") s = { ...s, payees: s.payees.map((p) => (p.id === b.payeeId ? { ...p, label: b.label, status: "active" as const } : p)) };
      else s = { ...s, payees: [...s.payees, { id: `p-${s.payees.length + 1}`, label: b.label, address: b.address, status: "active" as const, paidBefore: false, createdAt: at(0), warning: null }] };
      return s;
    },
    disputes: async () => d,
    dispute: async (b) => {
      const what = d.disputable.find((x) => x.id === b.id)!;
      d = {
        disputes: [{ id: `d-${d.disputes.length + 10}`, kind: b.kind, installationId: "i-1", agentName: what.agentName, what: what.what, amount: what.amount, decimals: 6, reason: b.reason, reasonWords: DISPUTE_REASON_WORDS[b.reason], note: b.note, status: "open", resolution: null, refund: "none", createdAt: at(0), resolvedAt: null }, ...d.disputes],
        disputable: d.disputable.filter((x) => x.id !== b.id),
      };
      return d;
    },
  };
}
