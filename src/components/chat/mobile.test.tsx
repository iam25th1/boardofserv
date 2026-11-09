import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EmptyState } from "./EmptyState";

// Phones: the examples on the empty chat are bordered buttons that count
// only a tap that didn't move; nothing you type in is under 16px; the
// keyboard resizes the page instead of covering it.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const touch = (el: Element, type: "pointerDown" | "pointerMove", x: number, y: number) => fireEvent[type](el, { pointerType: "touch", clientX: x, clientY: y });

describe("on a phone", () => {
  it("sends an example on a tap, not when the finger scrolled past it", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
    const picked: string[] = [];
    render(<EmptyState onPick={(t) => picked.push(t)} />);
    const [first, second] = screen.getAllByRole("button");
    // A scroll that began on the first example.
    touch(first!, "pointerDown", 100, 300);
    touch(first!, "pointerMove", 102, 260);
    fireEvent.click(first!);
    expect(picked).toEqual([]);
    // A tap, with a finger's small wobble.
    touch(second!, "pointerDown", 100, 400);
    touch(second!, "pointerMove", 103, 402);
    fireEvent.click(second!);
    expect(picked).toEqual(["Send me the three biggest AI stories every morning"]);
    // A mouse click always counts.
    fireEvent.pointerDown(first!, { pointerType: "mouse" });
    fireEvent.click(first!);
    expect(picked).toHaveLength(2);
  });

  it("keeps every field at 16px or more, so iOS never zooms in", () => {
    const tokens = readFileSync(join(__dirname, "../../design/tokens.css"), "utf8");
    expect(tokens).toMatch(/--t-input: 1rem;/);
    for (const css of ["../ui/TextInput.module.css", "../ui/Textarea.module.css"]) expect(readFileSync(join(__dirname, css), "utf8")).toMatch(/font-size: var\(--t-input\)/);
    expect(readFileSync(join(__dirname, "Composer.module.css"), "utf8")).toMatch(/\.area \{[^}]*font-size: var\(--t-input\)/);
    expect(readFileSync(join(__dirname, "../../app/globals.css"), "utf8")).toMatch(/@media \(pointer: coarse\)[\s\S]*font-size: max\(16px, 1em\) !important/);
  });

  it("asks the keyboard to resize the page, and lets the bars read the safe area", () => {
    // (Read from the layout's source: its fonts don't load under the tests.)
    const layout = readFileSync(join(__dirname, "../../app/layout.tsx"), "utf8");
    for (const want of ['width: "device-width"', "initialScale: 1", 'viewportFit: "cover"', 'interactiveWidget: "resizes-content"']) expect(layout).toContain(want);
    expect(readFileSync(join(__dirname, "../shell/AppShell.module.css"), "utf8")).toMatch(/height: var\(--app-h, 100dvh\)/);
  });
});
