import type { RequestDTO, RequestPageDTO } from "@/lib/types";

// Sample requests for /demo?market=requests and ?market=request
// (development only). Neutral, made-up people and needs.

const usdc = (whole: number) => String(BigInt(Math.round(whole * 1e6)));
const ago = (days: number) => new Date(Date.UTC(2026, 10, 12, 10) - days * 86_400_000).toISOString();
const base = (r: Partial<RequestDTO> & Pick<RequestDTO, "id" | "need">): RequestDTO => ({
  detail: "",
  connects: [],
  budget: null,
  decimals: 6,
  by: "sam_rivera",
  status: "open",
  meToo: 0,
  offers: 0,
  createdAt: ago(1),
  mine: false,
  votedByMe: false,
  held: null,
  ...r,
});

export const DEMO_REQUESTS: RequestDTO[] = [
  base({
    id: "q-1",
    need: "Remind customers about unpaid invoices",
    detail: "From a sheet of invoices: a polite reminder a week after the due date, and a second one after two weeks. Ask me before the second.",
    connects: ["sheets", "telegram"],
    budget: usdc(8),
    by: "noor_a",
    meToo: 12,
    offers: 2,
    createdAt: ago(6),
    votedByMe: true,
  }),
  base({ id: "q-2", need: "Tell me when a supplier changes a price on their page", connects: ["web", "telegram"], budget: usdc(3), by: "theo_m", meToo: 7, offers: 1, createdAt: ago(3) }),
  base({ id: "q-3", need: "Copy new form answers into a clean weekly summary tab", detail: "Our sign-up form fills a raw tab. Every Monday I'd like a tidy summary: counts by course, and new names.", connects: ["sheets"], by: "you_here", meToo: 3, createdAt: ago(1), mine: true }),
  base({ id: "q-4", need: "Post the day's bookings to our team chat at 7:00", connects: ["sheets", "telegram"], budget: usdc(2), by: "ida_w", meToo: 1, createdAt: ago(0.2) }),
];

export const DEMO_REQUEST: RequestPageDTO = {
  request: { ...DEMO_REQUESTS[0]!, mine: true, votedByMe: false },
  offers: [
    {
      id: "o-1",
      agent: { id: "00000000-0000-4000-8000-000000000003", name: "Enquiry follow-up", does: "Watches a sheet of enquiries, drafts a reply to each new one and asks you before sending it.", connects: ["telegram", "sheets"], version: 2, listed: true },
      maker: "lena_k",
      note: "Point it at your invoices tab instead of enquiries and it drafts the reminders. It asks you before each one.",
      weeklyPrice: usdc(6),
      jobFee: "0",
      decimals: 6,
      status: "open",
      createdAt: ago(4),
      mine: false,
      held: null,
    },
    {
      id: "o-2",
      agent: { id: "00000000-0000-4000-8000-000000000005", name: "Invoice nudge", does: "Reads an invoices sheet each morning and messages you the ones overdue, with a reminder drafted for each.", connects: ["telegram", "sheets"], version: 1, listed: false },
      maker: "maya_r",
      note: "Built for exactly this. The second reminder waits for your yes.",
      weeklyPrice: usdc(7.5),
      jobFee: usdc(0.1),
      decimals: 6,
      status: "open",
      createdAt: ago(2),
      mine: false,
      held: null,
    },
  ],
};
