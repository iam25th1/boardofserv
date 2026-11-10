import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Landing } from "./Landing";
import AboutPage from "@/app/about/page";
import EverythingPage from "@/app/everything/page";
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
    for (const [name, href] of [["About", "/about"], ["Support", "/support"], ["Using the beta", "/terms"], ["Your data", "/privacy"]]) expect(screen.getAllByRole("link", { name })[0]).toHaveAttribute("href", href);
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
  // Words that don't belong on a beta's plain notes. "draft" is a page's
  // state (a draft, a draft banner), not what an agent does when it drafts
  // an order, which the explainer describes.
  const BANNED = /terms of service|agreement|liabilit|warrant|indemn|governing law|jurisdiction|policy|policies|binding|company|business|customer|draft(?!\s+an?\s)|reviewed before it is final|legal advice/i;
  const PAGES = [
    { Page: AboutPage, h1: "About boardofserv" },
    { Page: TermsPage, h1: "Using the beta" },
    { Page: PrivacyPage, h1: "Your data" },
    { Page: SupportPage, h1: "Support" },
    { Page: EverythingPage, h1: "Everything you need to know" },
  ];

  it("are plain beta notes, with no legal or business words, no draft banner and no blanks to fill", () => {
    for (const { Page, h1 } of PAGES) {
      const { container } = render(<Page />);
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(h1);
      const text = container.textContent ?? "";
      expect(text, h1).not.toMatch(BANNED);
      expect(text, h1).not.toMatch(/\[|to be filled in|have this reviewed/i);
      expect(text, h1).not.toContain(String.fromCharCode(0x2014));
      expect(screen.queryByRole("note")).toBeNull();
      cleanup();
    }
    // The front page too.
    const { container } = render(<Landing />);
    expect(container.textContent ?? "").not.toMatch(BANNED);
  });

  it("still catch a draft for what it is", () => {
    for (const text of ["This is a draft.", "Draft: to be reviewed", "a draft of the beta's notes", "drafts"]) expect(text).toMatch(BANNED);
    expect("and draft an order for the cheapest supplier").not.toMatch(BANNED);
  });

  it("each have the button to the whole explainer in the footer", () => {
    for (const Page of [Landing, AboutPage, TermsPage, PrivacyPage, SupportPage, EverythingPage]) {
      render(<Page />);
      const footer = screen.getByRole("contentinfo");
      const button = within(footer).getByRole("link", { name: "Everything you need to know" });
      expect(button).toHaveAttribute("href", "/everything");
      // Above the footer's other links, and on the explainer, its own page.
      expect(button.compareDocumentPosition(within(footer).getByRole("navigation", { name: "More" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(button.getAttribute("aria-current")).toBe(Page === EverythingPage ? "page" : null);
      cleanup();
    }
  });

  it("link to each other by their new titles", () => {
    render(<Landing />);
    expect(screen.getAllByRole("link", { name: "Using the beta" })[0]).toHaveAttribute("href", "/terms");
    expect(screen.getAllByRole("link", { name: "Your data" })[0]).toHaveAttribute("href", "/privacy");
  });

  it("say what the beta is: a demo on test money, agents that make mistakes, resets, decency", () => {
    render(<TermsPage />);
    const main = screen.getByRole("main");
    for (const line of ["It's a demo. Don't rely on it for anything important.", "Agents can make mistakes.", "Test funds have no value", "Accounts and data may be reset", "Be decent to other people"]) expect(main).toHaveTextContent(line);
    cleanup();
    render(<AboutPage />);
    expect(screen.getByRole("main")).toHaveTextContent("boardofserv is an experiment in letting people build and rent small AI agents");
    expect(screen.getByRole("main")).toHaveTextContent("Payments use test USDC on Base Sepolia");
  });

  it("say what is kept, what for, how Google Sheets data is used, and how to have it deleted", () => {
    render(<PrivacyPage />);
    const main = screen.getByRole("main");
    for (const kept of ["email address", "wallet you link", "Telegram chat and your Google Sheets access", "log of each job", "payments history"]) expect(main).toHaveTextContent(kept);
    expect(main).toHaveTextContent("Nothing is sold, and nothing is shared for ads.");
    expect(main).toHaveTextContent("Your Google Sheets data is only read or written by the agents you set up, only on the tabs you give them, and only for the jobs you set. It isn't used for anything else, isn't shown to other people, and isn't used to train AI models.");
    expect(main).toHaveTextContent("Limited Use requirements");
    expect(within(main).getByRole("link", { name: "Support" })).toHaveAttribute("href", "/support");
  });

  it("gives support through the bot's /support, and the owner's email once it is set", () => {
    render(<SupportPage />);
    expect(screen.getByRole("link", { name: "@boardofservbot" })).toHaveAttribute("href", "https://t.me/boardofservbot");
    expect(screen.getByText("/support")).toBeInTheDocument();
    expect(screen.getByText("There's no email address yet. Telegram is the way for now.")).toBeInTheDocument();
    cleanup();
    vi.stubEnv("SUPPORT_EMAIL", "help@boardofserv.example");
    render(<SupportPage />);
    expect(screen.getByRole("link", { name: "help@boardofserv.example" })).toHaveAttribute("href", "mailto:help@boardofserv.example");
    vi.unstubAllEnvs();
  });
});
