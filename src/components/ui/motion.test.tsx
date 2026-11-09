import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { Dialog } from "./Dialog";
import { SkeletonCards, SkeletonPanel, SkeletonRows } from "./Skeletons";

// Loading shows the shape of what is coming and says so; a dialog leaves
// with an animation, and with reduced motion it simply goes.

function Opener() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open it
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title="A question">
        <button type="button" onClick={() => setOpen(false)}>
          Close it
        </button>
      </Dialog>
    </>
  );
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("motion and loading", () => {
  it("says what is loading, in chalk shapes rather than words", () => {
    render(
      <>
        <SkeletonCards label="Getting the board" count={3} />
        <SkeletonRows label="Getting your agents" />
        <SkeletonPanel label="Getting the job" />
      </>,
    );
    expect(screen.getByRole("status", { name: "Getting the board" }).children).toHaveLength(3);
    expect(screen.getByRole("status", { name: "Getting your agents" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Getting the job" })).toBeInTheDocument();
  });

  it("opens a dialog and, with reduced motion, closes it at once", async () => {
    render(<Opener />);
    fireEvent.click(screen.getByRole("button", { name: "Open it" }));
    expect(screen.getByRole("dialog", { name: "A question" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close it" }));
    await act(async () => {});
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
