import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { sketchFromDTO } from "@/lib/agentSketch";
import type { SketchDTO } from "@/lib/types";
import { SketchDock } from "./SketchDock";

// The dock itself, with reduced motion so every animation steps aside.

const blurb: SketchDTO = {
  name: "Shop blurb writer",
  kind: "answer",
  watches: null,
  when: null,
  how: null,
  tells: null,
  takes: "a product name and a few facts",
  does: "writes a friendly two line blurb",
  gives: null,
  asking: "gives",
  live: false,
};

beforeEach(() => {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SketchDock", () => {
  it("reads takes / does / gives for an answer helper", () => {
    const { container } = render(<SketchDock sketch={sketchFromDTO(blurb)} />);
    expect([...container.querySelectorAll("svg text")].map((t) => t.textContent)).toEqual(["takes", "does", "gives"]);
    expect([...container.querySelectorAll("[data-node]")].map((n) => n.getAttribute("data-state"))).toEqual(["on", "on", "ask"]);
    expect(screen.getByText("takes: done, does: done, gives: waiting on you")).toBeInTheDocument();
    expect([...container.querySelectorAll("[data-field] small")].map((s) => s.textContent)).toEqual(["Takes", "Does", "Gives back"]);
    expect(screen.getByText("Waiting on one answer from you")).toBeInTheDocument();
  });

  it("keeps watch / decide / tell you for an agent", () => {
    const { container } = render(
      <SketchDock sketch={sketchFromDTO({ ...blurb, kind: "watcher", takes: null, does: null, watches: "ETH", asking: "when" })} />,
    );
    expect([...container.querySelectorAll("svg text")].map((t) => t.textContent)).toEqual(["watch", "decide", "tell you"]);
    expect([...container.querySelectorAll("[data-field] small")].map((s) => s.textContent)).toEqual(["Keeps an eye on", "Acts when", "Checks", "Reaches you on"]);
  });

  it("has a small kind switch the maker can change, and none while its helper is on the board", () => {
    const onKind = vi.fn();
    render(<SketchDock sketch={sketchFromDTO(blurb)} onKind={onKind} />);
    const kind = screen.getByRole("combobox", { name: "Kind" });
    expect(kind).toHaveValue("answer");
    expect([...kind.querySelectorAll("option")].map((o) => o.textContent)).toEqual(["answer", "agent", "watcher", "digest", "helper"]);
    fireEvent.change(kind, { target: { value: "digest" } });
    expect(onKind).toHaveBeenCalledWith("digest");
    cleanup();

    render(<SketchDock sketch={sketchFromDTO({ ...blurb, gives: "the blurb", asking: null })} onKind={onKind} published="shop-blurb-writer" />);
    expect(screen.getByRole("combobox", { name: "Kind" })).toBeDisabled();
    cleanup();

    // The development fixtures have no switch.
    render(<SketchDock sketch={sketchFromDTO(blurb)} />);
    expect(screen.queryByRole("combobox", { name: "Kind" })).toBeNull();
  });
});
