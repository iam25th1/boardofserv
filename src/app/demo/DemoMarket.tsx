"use client";
import { useMemo } from "react";
import { AppShell } from "@/components/shell/AppShell";
import { BoardView } from "@/components/market/BoardView";
import { AgentPageView } from "@/components/market/AgentPageView";
import { RentalView, type RentalApi } from "@/components/market/RentalView";
import { RentalsView } from "@/components/market/RentalsView";
import { Page } from "@/components/shell/Page";
import { YourAgentsNav } from "@/components/shell/SubNav";
import { DEMO_DASHBOARD, demoJob, DEMO_NOW, DEMO_RENTAL, DEMO_RENTALS, DEMO_RUNS } from "./demoRentals";
import { MakerDashboard, type MakerDashboardApi } from "@/components/market/MakerDashboard";
import { RequestsView, type RequestsApi } from "@/components/market/RequestsView";
import { RequestPageView, type RequestPageApi } from "@/components/market/RequestPageView";
import { DEMO_REQUEST, DEMO_REQUESTS } from "./demoRequests";
import { TRUST_FAIR, TRUST_NEW, TRUST_STRONG } from "./demoTrust";
import type { AgentListingDTO, AgentPageDTO, PublicHelperDTO } from "@/lib/types";

// /demo?market=board, agent, example, rentals, rental, maker, requests or request
// (development only): the market's
// screens with sample data, to look at and screenshot without a database
// or a sign-in. Neutral, made-up agents and makers.

const usdc = (whole: number) => String(BigInt(Math.round(whole * 1e6)));

export const DEMO_AGENTS: AgentListingDTO[] = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    name: "Fabric restock",
    does: "Checks your stock sheet every morning, compares three suppliers' prices and records an order for anything low, asking you first over your limit.",
    connects: ["telegram", "sheets", "web"],
    weeklyPrice: usdc(12),
    jobFee: "0",
    decimals: 6,
    renters: 14,
    maker: "maya_r",
    version: 3,
    quality: { score: 88, reviewed: 24, minimum: 5, ship: 83, review: 13, block: 4, previous: { version: 2, score: 81, reviewed: 30 } },
    trust: TRUST_STRONG,
    createdAt: "2026-11-02T09:00:00.000Z",
    modelEstimate: usdc(0.12),
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    name: "Morning sheet report",
    does: "Reads a sheet every morning and sends you a short summary of what changed on Telegram.",
    connects: ["telegram", "sheets"],
    weeklyPrice: usdc(4),
    jobFee: "0",
    decimals: 6,
    renters: 9,
    maker: "sam_rivera",
    version: 1,
    quality: { score: 74, reviewed: 9, minimum: 5, ship: 56, review: 44, block: 0, previous: null },
    trust: TRUST_FAIR,
    createdAt: "2026-11-05T09:00:00.000Z",
    modelEstimate: usdc(0.08),
  },
  {
    id: "00000000-0000-4000-8000-000000000003",
    name: "Enquiry follow-up",
    does: "Watches a sheet of enquiries, drafts a reply to each new one and asks you before sending it.",
    connects: ["telegram", "sheets"],
    weeklyPrice: usdc(9),
    jobFee: usdc(0.25),
    decimals: 6,
    renters: 6,
    maker: "lena_k",
    version: 2,
    quality: { score: null, reviewed: 2, minimum: 5, ship: 50, review: 50, block: 0, previous: null },
    trust: TRUST_NEW,
    createdAt: "2026-11-06T09:00:00.000Z",
    modelEstimate: usdc(0.85),
  },
  {
    id: "00000000-0000-4000-8000-000000000004",
    name: "Price watch",
    does: "Checks a product page every hour and tells you when the price drops below the one you set.",
    connects: ["telegram", "web"],
    weeklyPrice: "0",
    jobFee: "0",
    decimals: 6,
    renters: 2,
    maker: "theo_m",
    version: 1,
    quality: { score: null, reviewed: 0, minimum: 5, ship: 0, review: 0, block: 0, previous: null },
    trust: TRUST_NEW,
    createdAt: "2026-11-08T09:00:00.000Z",
    modelEstimate: usdc(0.34),
  },
];

const HELPERS: PublicHelperDTO[] = [
  { slug: "shop-blurbs", name: "Shop blurbs", description: "Turns a product and a few facts into a friendly two line blurb.", inputHint: "A product", maker: "maya_r", createdAt: "2026-10-22T09:00:00.000Z", prices: [] },
  { slug: "haiku-maker", name: "Haiku maker", description: "A haiku about anything you give it.", inputHint: "A subject", maker: "sam_rivera", createdAt: "2026-10-20T09:00:00.000Z", prices: [] },
];

export const DEMO_PAGE: AgentPageDTO = {
  ...DEMO_AGENTS[0]!,
  done: "Every low fabric has an order row in the Orders sheet, or you said no.",
  runs: ["Runs every day at 8:00"],
  steps: [
    { kind: "works", title: "Read stock and supplier prices", outcomes: [] },
    { kind: "decides", title: "Anything to reorder today?", outcomes: ["Orders found", "Nothing low"] },
    { kind: "acts", title: "Tell you stock is fine", outcomes: [] },
    { kind: "works", title: "Prepare the order rows", outcomes: [] },
    { kind: "acts", title: "Write the orders to your sheet", outcomes: [] },
    { kind: "acts", title: "Remember the last order", outcomes: [] },
  ],
  asks: [
    { label: "Stock sheet", help: "A Google Sheet tab with columns: fabric, metres, minimum", kind: "sheet" },
    { label: "Suppliers' price page", help: "A page with one supplier, fabric, price and delivery time per line", kind: "url" },
    { label: "Orders sheet", help: "A Google Sheet tab where order rows are added", kind: "sheet" },
  ],
  needs: { telegram: true, google: true },
  neverWithoutAsking: ['Spend more in one job than your limit "Order approval limit" (250 USDC unless you change it).'],
  canOnly: ["Tell you stock is fine today", "Write new order rows to the Orders sheet", "Remember the last order placed"],
  mine: false,
  rentalId: null,
};

// The Fabric restock example as its listing reads after the beta launch:
// the words from src/lib/agents/examples/restock.json (never its code),
// free to rent, by the site's admin.
export const EXAMPLE_PAGE: AgentPageDTO = {
  ...DEMO_PAGE,
  id: "00000000-0000-4000-8000-0000000000e1",
  name: "Fabric restock",
  does: "Every morning it checks your fabric stock, finds the cheapest supplier that delivers in time for anything running low, and writes the order rows into your Orders tab. Orders over your limit wait for your yes, in Telegram or the app.",
  done: "Every fabric running low has an order row in your Orders tab, or you said no.",
  weeklyPrice: "0",
  renters: 0,
  maker: "boardofserv",
  version: 2,
  quality: { score: null, reviewed: 0, minimum: 5, ship: 0, review: 0, block: 0, previous: null },
  trust: TRUST_NEW,
  steps: [{"kind": "works", "title": "Read stock and supplier data", "outcomes": []}, {"kind": "decides", "title": "Is anything running low?", "outcomes": ["Fabrics need reordering", "Stock levels are fine"]}, {"kind": "acts", "title": "Tell you stock is fine", "outcomes": []}, {"kind": "works", "title": "Get the order rows ready", "outcomes": []}, {"kind": "acts", "title": "Write the orders to your sheet", "outcomes": []}, {"kind": "works", "title": "Get the last order ready to remember", "outcomes": []}, {"kind": "acts", "title": "Remember the last order", "outcomes": []}],
  asks: [{"label": "Stock sheet", "help": "A Google Sheet tab with columns: fabric, metres, minimum", "kind": "sheet"}, {"label": "Address of the suppliers' price list page", "help": "Page with one header line, then supplier | fabric | price_usdc | delivery_days per line", "kind": "url"}, {"label": "Orders sheet", "help": "A Google Sheet tab where order rows are added", "kind": "sheet"}, {"label": "Order approval limit in USDC", "help": "Orders over this wait for your yes, in Telegram or the app", "kind": "number"}, {"label": "Maximum acceptable delivery time in days", "help": "Only suppliers delivering within this timeframe will be considered", "kind": "number"}],
  neverWithoutAsking: ['Spend more in one job than your limit "Order approval limit" (250 USDC unless you change it).'],
  canOnly: ["Tell you stock levels are fine today", "Write new order rows to your Orders tab", "Remember the last order placed"],
};

export function DemoMarket({ view }: { view: string }) {
  const load = useMemo(
    () => async (q: { q?: string; kind?: string; connects?: string[] }) => {
      const words = (q.q ?? "").toLowerCase();
      const agents = DEMO_AGENTS.filter((a) => (q.kind === "helpers" ? false : true) && (!words || `${a.name} ${a.does}`.toLowerCase().includes(words)) && (q.connects ?? []).every((c) => a.connects.includes(c as never)));
      const helpers = q.kind === "agents" || (q.connects ?? []).length ? [] : HELPERS.filter((h) => !words || h.name.toLowerCase().includes(words));
      return { agents, helpers };
    },
    [],
  );
  const pageApi = useMemo(() => ({ load: async () => DEMO_PAGE }), []);
  const exampleApi = useMemo(() => ({ load: async () => EXAMPLE_PAGE }), []);
  const rentalApi = useMemo<RentalApi>(
    () => ({
      load: async () => DEMO_RENTAL,
      control: async () => DEMO_RENTAL,
      run: async () => undefined,
      job: async (id) => demoJob(id),
      answer: async () => undefined,
      version: async () => ({ rental: DEMO_RENTAL, setupAgain: false }),
      now: () => DEMO_NOW,
    }),
    [],
  );
  const rentals = useMemo(() => async () => DEMO_RENTALS, []);
  const requestsApi = useMemo<RequestsApi>(
    () => ({
      load: async (sort) => (sort === "newest" ? [...DEMO_REQUESTS].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : DEMO_REQUESTS),
      ask: async () => ({ id: "q-new" }),
      meToo: async () => undefined,
    }),
    [],
  );
  const requestApi = useMemo<RequestPageApi>(
    () => ({ load: async () => DEMO_REQUEST, meToo: async () => DEMO_REQUEST, close: async () => DEMO_REQUEST, accept: async () => ({ id: "r-1" }) as never, withdraw: async () => undefined }),
    [],
  );
  const dashApi = useMemo<MakerDashboardApi>(() => ({ load: async () => DEMO_DASHBOARD, runs: async () => DEMO_RUNS }), []);
  return (
    <AppShell>
      {view === "example" ? (
        <AgentPageView id={EXAMPLE_PAGE.id} api={exampleApi} />
      ) : view === "agent" ? (
        <AgentPageView id={DEMO_PAGE.id} api={pageApi} />
      ) : view === "requests" ? (
        <RequestsView api={requestsApi} />
      ) : view === "request" ? (
        <RequestPageView id="q-1" api={requestApi} />
      ) : view === "maker" ? (
        <MakerDashboard id={DEMO_DASHBOARD.agentId} api={dashApi} />
      ) : view === "rental" ? (
        <RentalView id={DEMO_RENTAL.id} api={rentalApi} />
      ) : view === "rentals" ? (
        <Page title="Rented" note="agents you rent by the week" width="wide" above={<YourAgentsNav />}>
          <RentalsView load={rentals} />
        </Page>
      ) : (
        <BoardView load={load} />
      )}
    </AppShell>
  );
}
