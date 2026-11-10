import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import EverythingPage from "@/app/everything/page";
import { COMPARISON, CONTENTS } from "./Everything";

// Everything you need to know: the page says what the doc in the repo says,
// word for word, in a shape you can read and jump around; and it eases in
// as you scroll, unless motion is reduced.

const DOC = readFileSync(join(process.cwd(), "docs/boardofserv-everything-you-need-to-know.md"), "utf8");

// The doc's words without the markdown: headings without their marks or
// emoji, list items without their markers, bold and links as plain words,
// and a table as its cells.
function docChunks(md: string): string[] {
  const chunks: string[] = [];
  for (const raw of md.split("\n")) {
    const line = raw.trim();
    if (!line || /^\|[-| ]+\|$/.test(line)) continue;
    if (line.startsWith("|")) {
      chunks.push(...line.split("|").map((c) => c.trim()).filter(Boolean));
      continue;
    }
    chunks.push(
      line
        .replace(/^#+\s*/, "")
        .replace(/^\p{Extended_Pictographic}️?\s*/u, "")
        .replace(/^(\d+\.|-)\s+/, "")
        .replace(/\*\*/g, "")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1"),
    );
  }
  return chunks.map(plain);
}

// Curly quotes on the page, straight in the doc; spaces as spaces.
const plain = (s: string) => s.replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();

beforeEach(() => {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the explainer", () => {
  it("has every word of the doc, and nothing the doc doesn't say", () => {
    render(<EverythingPage />);
    const main = screen.getByRole("main");
    const page = plain(main.textContent ?? "");
    const chunks = docChunks(DOC);
    expect(chunks.length).toBeGreaterThan(60);
    for (const chunk of chunks) expect(page, chunk).toContain(chunk);

    // The other way: each heading, paragraph, list item and cell on the page
    // is in the doc (the contents list repeats the headings, and a step's
    // number is its list's).
    const doc = chunks.join("\n");
    const blocks = [...main.querySelectorAll("h1, h2, h3, p, li, th, td, li > span")].filter((el) => !el.closest("nav") && !el.querySelector("p, span"));
    expect(blocks.length).toBeGreaterThan(80);
    for (const el of blocks) {
      const text = plain(el.textContent ?? "");
      if (/^\d$/.test(text) || !text) continue;
      expect(doc, text).toContain(text);
    }
  });

  it("uses no em dash and no emoji: the partners have chalk drawings instead", () => {
    const { container } = render(<EverythingPage />);
    const text = container.textContent ?? "";
    expect(text).not.toContain(String.fromCharCode(0x2014));
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    for (const name of ["SERV Reasoning (by OpenServ): the brain", "Dolphin: the hands", "Reppo: the judge", "Base and USDC: the wallet"]) {
      const heading = screen.getByRole("heading", { level: 3, name });
      const partner = heading.closest("[data-reveal]")!;
      const drawing = partner.querySelector("svg");
      expect(drawing, name).not.toBeNull();
      // The name says who it is; the drawing is left out of what is read.
      expect(drawing!.getAttribute("aria-hidden")).toBe("true");
      expect(drawing!.querySelectorAll("[data-draw]").length, name).toBeGreaterThan(2);
    }
    // The doc keeps the emoji on the same four headings.
    for (const heading of ["### 🧠 SERV Reasoning (by OpenServ): the brain", "### ✋ Dolphin: the hands", "### ⚖️ Reppo: the judge", "### 💵 Base and USDC: the wallet"]) expect(DOC).toContain(heading);
  });

  it("opens with its title and a contents list that jumps to every part, in order", () => {
    render(<EverythingPage />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Everything you need to know");
    const contents = screen.getByRole("navigation", { name: "Contents" });
    const links = within(contents).getAllByRole("link");
    const parts = screen.getAllByRole("heading", { level: 2 });
    expect(links.map((a) => a.textContent)).toEqual(parts.map((h) => h.textContent));
    expect(links.map((a) => a.getAttribute("href"))).toEqual(parts.map((h) => `#${h.id}`));
    expect(parts.map((h) => h.textContent)).toEqual(CONTENTS.map(([, title]) => title));
    // Each part is a section named by its heading.
    for (const h of parts) expect(h.closest("section")).toHaveAttribute("aria-labelledby", h.id);
  });

  it("keeps the steps and lists as real lists", () => {
    render(<EverythingPage />);
    const steps = screen.getByRole("heading", { name: "How it works if you need an agent" }).closest("section")!;
    const ol = steps.querySelector("ol")!;
    expect(within(ol).getAllByRole("listitem").map((li) => li.querySelector("strong")?.textContent)).toEqual([
      "Find one on the board.",
      "Rent it by the week.",
      "Set it up in a few steps.",
      "Go live your life.",
    ]);
    const serv = screen.getByRole("heading", { name: "SERV Reasoning (by OpenServ): the brain" }).parentElement!;
    expect(within(serv).getAllByRole("listitem")).toHaveLength(4);
    const where = screen.getByRole("heading", { name: "Where we are" }).closest("section")!;
    expect(within(where).getAllByRole("listitem")).toHaveLength(5);
  });

  it("sets a typical agent beside a boardofserv one: a table, and the same rows as two lists", () => {
    render(<EverythingPage />);
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((th) => th.textContent)).toEqual(["A typical agent", "A boardofserv agent"]);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((r) => [...r.children].map((c) => plain(c.textContent ?? "")))).toEqual(COMPARISON.map((r) => r.map(plain)));
    expect(within(table).getAllByRole("rowheader")).toHaveLength(COMPARISON.length);
    // The phone's two lists: one per kind of agent, every row in each.
    for (const [i, kind] of (["A typical agent", "A boardofserv agent"] as const).entries()) {
      const list = screen.getByRole("heading", { level: 3, name: kind }).parentElement!.querySelector("ul")!;
      expect([...list.children].map((li) => [...li.children].map((s) => plain(s.textContent ?? "")))).toEqual(COMPARISON.map((r) => [r[0], plain(r[i + 1]!)]));
    }
    // Which of the two shows is the stylesheet's call, at phone width.
    const css = readFileSync(join(__dirname, "Everything.module.css"), "utf8");
    expect(css).toMatch(/@media \(max-width: 640px\) \{[\s\S]*\.table \{\n {4}display: none;[\s\S]*\.stacked \{\n {4}display: flex;/);
  });
});

describe("the explainer's motion", () => {
  // A long page: every part starts below the screen.
  function belowTheFold() {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ top: 5000, bottom: 5400, left: 0, right: 600, width: 600, height: 400, x: 0, y: 5000, toJSON() {} });
  }
  function observer() {
    const seen: { cb: IntersectionObserverCallback; targets: Element[]; off: boolean }[] = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        entry: { cb: IntersectionObserverCallback; targets: Element[]; off: boolean };
        constructor(cb: IntersectionObserverCallback) {
          this.entry = { cb, targets: [], off: false };
          seen.push(this.entry);
        }
        observe(el: Element) {
          this.entry.targets.push(el);
        }
        disconnect() {
          this.entry.off = true;
        }
        // Next's links watch themselves to prefetch.
        unobserve() {}
        takeRecords() {
          return [];
        }
      },
    );
    return seen;
  }

  it("with reduced motion, shows every part at once", () => {
    belowTheFold();
    observer();
    const { container } = render(<EverythingPage />);
    const parts = container.querySelectorAll<HTMLElement>("[data-reveal]");
    expect(parts.length).toBe(CONTENTS.length + 4 + 1);
    for (const part of parts) expect(part.style.opacity).toBe("");
  });

  it("otherwise hides each part below the screen until it scrolls into view, once", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
    belowTheFold();
    const seen = observer();
    const { container } = render(<EverythingPage />);
    const parts = [...container.querySelectorAll<HTMLElement>("[data-reveal]")];
    for (const part of parts) expect(part.style.opacity).toBe("0");
    const first = seen.find((o) => o.targets[0] === parts[0])!;
    act(() => first.cb([{ isIntersecting: true, target: parts[0] } as unknown as IntersectionObserverEntry], {} as IntersectionObserver));
    expect(first.off).toBe(true);
  });

  it("leaves what is already on screen as it is", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
    observer();
    const { container } = render(<EverythingPage />);
    for (const part of container.querySelectorAll<HTMLElement>("[data-reveal]")) expect(part.style.opacity).toBe("");
  });
});
