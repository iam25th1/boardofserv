import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PublicHelperDTO } from "@/lib/types";
import BoardPage from "./page";

// The board page with the network replaced. The entrance is counted, not
// watched: anime's timeline is wrapped so the test sees each one created.

const timelines = vi.hoisted(() => ({ count: 0 }));
vi.mock("animejs", async (load) => {
  const real = await load<typeof import("animejs")>();
  const inert = { add: () => inert };
  return {
    ...real,
    createTimeline: () => {
      timelines.count += 1;
      return inert;
    },
    svg: { ...real.svg, createDrawable: () => [] },
  };
});

const helper = (slug: string, name: string): PublicHelperDTO => ({
  slug,
  name,
  description: `What ${name} does`,
  inputHint: "Something",
  maker: "maya",
  createdAt: "2026-10-22T09:00:00.000Z",
  prices: [],
});
const requests: string[] = [];
let board: PublicHelperDTO[] = [];

function motion(reduce: boolean) {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: reduce && q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
}

beforeEach(() => {
  timelines.count = 0;
  requests.length = 0;
  board = [helper("haiku-maker", "Haiku maker"), helper("shop-blurbs", "Shop blurbs")];
  vi.stubGlobal("fetch", async (url: string) => {
    requests.push(url);
    const q = new URL(url, "http://localhost").searchParams.get("q")?.toLowerCase() ?? "";
    return Response.json({ helpers: board.filter((h) => h.name.toLowerCase().includes(q)) });
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function settle(ms = 0) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

describe("the board", () => {
  it("shows each helper as a card linking to its page, in the order given", async () => {
    motion(true);
    render(<BoardPage />);
    await settle();
    const cards = screen.getAllByRole("link").filter((a) => a.getAttribute("href")?.startsWith("/h/"));
    expect(cards.map((a) => a.getAttribute("href"))).toEqual(["/h/haiku-maker", "/h/shop-blurbs"]);
    expect(cards[0]).toHaveTextContent("Haiku makerWhat Haiku maker does@maya");
    expect(screen.getByRole("link", { name: "Board" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Your agents" })).toHaveAttribute("href", "/chat");
  });

  it("chalks the cards on once, on the first load, and never for a search", async () => {
    motion(false);
    render(<BoardPage />);
    await settle();
    expect(timelines.count).toBe(1);

    fireEvent.change(screen.getByLabelText("Search helpers by name"), { target: { value: "shop" } });
    await settle(250);
    expect(requests.at(-1)).toBe("/api/board?q=shop");
    expect(screen.getAllByRole("link").filter((a) => a.getAttribute("href")?.startsWith("/h/"))).toHaveLength(1);
    expect(timelines.count).toBe(1);
  });

  it("does not animate at all with reduced motion", async () => {
    motion(true);
    render(<BoardPage />);
    await settle();
    expect(timelines.count).toBe(0);
  });

  it("says when nothing is on the board, or nothing matches", async () => {
    motion(true);
    board = [];
    render(<BoardPage />);
    await settle();
    expect(screen.getByText("Nothing on the board yet.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search helpers by name"), { target: { value: "zzz" } });
    await settle(250);
    expect(screen.getByText("Nothing on the board matches that.")).toBeInTheDocument();
  });
});
