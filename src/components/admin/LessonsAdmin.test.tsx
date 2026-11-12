import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { LessonsAdmin } from "./LessonsAdmin";

// The admin's lessons, the most often learned first, saying which go to the
// planner and Dolphin as rules.

afterEach(cleanup);

describe("the lessons page", () => {
  it("lists lessons by how often they were learned, and says which are given as rules", async () => {
    const load = async () => [
      { kind: "extra_question", rule: "Never ask before a payment: it asks by itself.", wrong: "It asked twice.", fix: "Took the question out.", count: 4, makers: 3, lastSeenAt: "2026-11-11T10:00:00.000Z" },
      { kind: "sample_payee", rule: "The sample saves the payee it pays.", wrong: "No payee.", fix: "A new sample.", count: 1, makers: 1, lastSeenAt: "2026-11-11T09:00:00.000Z" },
    ];
    render(<LessonsAdmin load={load} />);
    const items = await screen.findAllByRole("listitem");
    expect(items[0]).toHaveTextContent("4A question nobody asked for3 makers");
    expect(items[0]).toHaveTextContent("given to the planner and Dolphin");
    expect(items[0]).toHaveTextContent("What went wrongIt asked twice.What fixed itTook the question out.");
    expect(items[1]).toHaveTextContent("1The sample's payee1 maker");
    expect(items[1]).not.toHaveTextContent("given to the planner");
  });
});
