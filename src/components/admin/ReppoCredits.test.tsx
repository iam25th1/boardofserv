import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DEMO_SAFETY } from "@/app/demo/demoSafety";
import { ReppoCredits } from "./ReppoCredits";

// The admin's Reppo panel: credits today against the budget, this week,
// in flight and waiting, why nothing goes out, the settings in force.

afterEach(cleanup);

describe("Reppo's credits for the admin", () => {
  it("shows today against the day's budget, this week and the settings", () => {
    render(<ReppoCredits r={DEMO_SAFETY.reppo} />);
    expect(screen.getByRole("img", { name: "2,640 of 4,400 credits used today" })).toBeInTheDocument();
    expect(screen.getByText("2,640 of 4,400 credits, 6 evaluations")).toBeInTheDocument();
    expect(screen.getByText("11,440 credits, 26 evaluations")).toBeInTheDocument();
    expect(screen.getByText(/The first 3 finished jobs of each new version are scored, then one in 10\./)).toBeInTheDocument();
    expect(screen.getByText(/10 evaluations at 440 each/)).toBeInTheDocument();
  });

  it("says why nothing goes out: off, refused, or the day's budget spent", () => {
    render(<ReppoCredits r={{ ...DEMO_SAFETY.reppo, on: false }} />);
    expect(screen.getByText(/Off: no REPPO_API_KEY/)).toBeInTheDocument();
    cleanup();
    render(<ReppoCredits r={{ ...DEMO_SAFETY.reppo, paused: "Reppo's credits ran out, so nothing goes out for an hour." }} />);
    expect(screen.getByRole("status")).toHaveTextContent("credits ran out");
    cleanup();
    render(<ReppoCredits r={{ ...DEMO_SAFETY.reppo, budgetSpent: true }} />);
    expect(screen.getByRole("status")).toHaveTextContent("Today's budget is used up");
  });
});
