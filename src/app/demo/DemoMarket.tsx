"use client";
import { useMemo } from "react";
import { AppShell } from "@/components/shell/AppShell";
import { BoardView } from "@/components/market/BoardView";
import { AgentPageView } from "@/components/market/AgentPageView";
import { RentalView, type RentalApi } from "@/components/market/RentalView";
import { RentalsView } from "@/components/market/RentalsView";
import { Page } from "@/components/shell/Page";
import { YourAgentsNav } from "@/components/shell/SubNav";
import { demoJob, DEMO_NOW, DEMO_RENTAL, DEMO_RENTALS } from "./demoRentals";
import type { AgentListingDTO, AgentPageDTO, PublicHelperDTO } from "@/lib/types";

// /demo?market=board, agent, rentals or rental (development only): the market's
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
    quality: null,
    trust: null,
    createdAt: "2026-11-02T09:00:00.000Z",
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
    quality: null,
    trust: null,
    createdAt: "2026-11-05T09:00:00.000Z",
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
    quality: null,
    trust: null,
    createdAt: "2026-11-06T09:00:00.000Z",
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
    quality: null,
    trust: null,
    createdAt: "2026-11-08T09:00:00.000Z",
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
  const rentalApi = useMemo<RentalApi>(
    () => ({
      load: async () => DEMO_RENTAL,
      control: async () => DEMO_RENTAL,
      run: async () => undefined,
      job: async (id) => demoJob(id),
      answer: async () => undefined,
      now: () => DEMO_NOW,
    }),
    [],
  );
  const rentals = useMemo(() => async () => DEMO_RENTALS, []);
  return (
    <AppShell>
      {view === "agent" ? (
        <AgentPageView id={DEMO_PAGE.id} api={pageApi} />
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
