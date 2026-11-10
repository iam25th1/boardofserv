import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Landing } from "./Landing";
import AboutPage from "@/app/about/page";
import PrivacyPage from "@/app/privacy/page";
import SupportPage from "@/app/support/page";
import TermsPage from "@/app/terms/page";

// The front page and the public pages: every section there, the way into
// the app, drafts marked as drafts, and nothing an outside reader would
// take for a claim the product doesn't keep.

beforeEach(() => {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the front page", () => {
  it("has its parts, in order, and a way in", () => {
    render(<Landing />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Small agents that do one job for you, every week.");
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      "For anyone who needs an agent",
      "For makers",
      "How it works",
      "Can't find it? Ask for it.",
      "Your rules, your data",
      "Powered by",
      "Give one job away.",
    ]);
    // How it works is a real sequence: three numbered steps.
    const how = screen.getByRole("heading", { name: "How it works" }).closest("section")!;
    expect(within(how).getAllByRole("listitem")).toHaveLength(3);
    // Signed out here (no sign-in set up in the tests): sign in, or the board.
    expect(screen.getAllByRole("link", { name: "Sign in" })[0]).toHaveAttribute("href", "/login");
    expect(screen.getAllByRole("link", { name: "Browse the board" })[0]).toHaveAttribute("href", "/app/board");
    for (const name of ["About", "Support", "Terms", "Privacy"]) expect(screen.getAllByRole("link", { name })[0]).toHaveAttribute("href", `/${name.toLowerCase()}`);
  });

  it("shows one hero drawing at a time: the wide one, or on a phone the tall one", () => {
    // The tall one's hiding comes after the shared rule that shows every
    // drawing, or that rule would show it too.
    const css = readFileSync(join(__dirname, "Landing.module.css"), "utf8");
    const shared = css.indexOf(".machine,\n.drawing {");
    const hidden = css.search(/\n\.machineTall \{\n  display: none;/);
    expect(shared).toBeGreaterThan(-1);
    expect(hidden).toBeGreaterThan(shared);
  });

  it("names what powers it as words, and keeps to what is true", () => {
    const { container } = render(<Landing />);
    const powered = screen.getByRole("heading", { name: "Powered by" }).closest("section")!;
    for (const name of ["SERV Reasoning", "Dolphin", "Reppo", "Base", "USDC", "Telegram", "Google Sheets"]) expect(powered).toHaveTextContent(name);
    expect(powered).toHaveTextContent("Reppo checks the quality of agents' work");
    expect(powered.querySelector("img")).toBeNull();
    const text = container.textContent ?? "";
    expect(text).toContain("90% of each week's rent is yours");
    expect(text).not.toContain(String.fromCharCode(0x2014));
    // Every drawing says what it shows.
    for (const svg of container.querySelectorAll("svg[role='img']")) expect(svg.getAttribute("aria-label")).toBeTruthy();
  });
});

describe("the beta", () => {
  it("is tagged beside the mark, and said near the top: it runs on test money", () => {
    render(<Landing />);
    const header = screen.getAllByRole("banner")[0]!;
    expect(within(header).getByText("beta")).toBeInTheDocument();
    const hero = screen.getByRole("heading", { level: 1 }).closest("section")!;
    expect(hero).toHaveTextContent("It's a beta: it runs on test money (test USDC on Base Sepolia, worth nothing)");
  });

  it("names trust scores, spending limits and Reppo's quality scores beside approvals and your rules", () => {
    render(<Landing />);
    const safety = screen.getByRole("heading", { name: "Your rules, your data" }).closest("section")!;
    for (const point of ["Your rules.", "Approvals.", "Spending limits.", "Trust scores.", "Quality scores."]) expect(safety).toHaveTextContent(point);
    expect(safety).toHaveTextContent("a score from 300 to 850");
    expect(safety).toHaveTextContent("Reppo reviews a sample of each agent's jobs");
  });
});

describe("the public pages", () => {
  it("marks terms and privacy as drafts for the owner, at the top", () => {
    for (const Page of [TermsPage, PrivacyPage]) {
      render(<Page />);
      const main = screen.getByRole("main");
      expect(main.firstElementChild).toHaveAttribute("role", "note");
      expect(main.firstElementChild).toHaveTextContent(/^Draft:/);
      cleanup();
    }
  });

  it("gives support through the bot's /support and an email the owner fills in", () => {
    render(<SupportPage />);
    expect(screen.getByRole("link", { name: "@boardofservbot" })).toHaveAttribute("href", "https://t.me/boardofservbot");
    expect(screen.getByText("/support")).toBeInTheDocument();
    expect(screen.getByText(/support email address, to be filled in by the owner/)).toBeInTheDocument();
  });

  it("says what boardofserv is", () => {
    render(<AboutPage />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("About boardofserv");
    expect(screen.getByRole("main")).toHaveTextContent("90% goes to the agent's maker");
  });
});
