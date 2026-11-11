import { describe, expect, it } from "vitest";
import { definitionOf, MOTIVATION_WIRE, PRICE_WIRE } from "@/test/suiteFixtures";
import { NESTED_HACKATHON_WIRE } from "@/test/hackathonFixture";
import { heldByYes, weakens } from "./guarded";
import type { AgentDefinition, AgentStep } from "./definition";

// Repairs that try to trade away what keeps an agent safe, each turned
// down: an owner's yes, a spending limit, the maker's own rules and answers,
// the run's limits, and the check a test failed.

const price = definitionOf(PRICE_WIRE);
const without = (d: AgentDefinition, ids: string[], rewire: Record<string, string | null>): AgentDefinition => ({
  ...d,
  steps: d.steps
    .filter((s) => !ids.includes(s.id))
    .map((s): AgentStep => {
      const to = (n: string | null) => (n !== null && n in rewire ? rewire[n]! : n);
      if (s.kind === "decision") return { ...s, outcomes: s.outcomes.map((o) => ({ ...o, next: to(o.next) })) };
      if (s.kind === "loop") return { ...s, next: to(s.next) };
      return { ...s, next: to(s.next) };
    }),
});

// A restock agent that writes orders worth money, asking over a limit.
const spending = (askOver: string | undefined, value = "250"): AgentDefinition => ({
  ...price,
  rules: [{ key: "approval_over_usdc", label: "Ask me before orders over", type: "usdc", value, help: "Orders over this wait for your yes." }],
  actions: [...price.actions, { id: "record_order", tool: "sheets.write", description: "Add the order", amountColumn: "total_usdc", ...(askOver ? { askOver } : {}) }],
});

describe("a repair", () => {
  it("is turned down when it would send without the owner's yes the plan waited for", () => {
    expect(heldByYes(price)).toEqual(["telegram.send"]);
    // The question and the yes taken out: the reminder goes straight out.
    const noQuestion = without(price, ["make_question", "ask", "said_yes"], { make_question: "make_reminder" });
    expect(weakens(price, noQuestion)).toBe("It would send you messages without your yes first, which it waited for before.");
    // The question kept, but a no goes on to the reminder too.
    const both = { ...price, steps: price.steps.map((s) => (s.id === "said_yes" && s.kind === "decision" ? { ...s, outcomes: s.outcomes.map((o) => ({ ...o, next: "make_reminder" })) } : s)) };
    expect(weakens(price, both)).toMatch(/without your yes first/);
    // A change that keeps the yes in front of the send is fine.
    const reworded = { ...price, steps: price.steps.map((s) => (s.id === "make_reminder" && s.kind === "code" ? { ...s, description: `${s.description} Keep it short.` } : s)) };
    expect(weakens(price, reworded)).toBeNull();
  });

  it("is turned down when it would stop counting spending, or drop or raise the limit it asks over", () => {
    const before = spending("approval_over_usdc");
    expect(weakens(before, spending(undefined))).toBe("It would drop or raise the limit it asks you over before spending.");
    expect(weakens(before, spending("approval_over_usdc", "1000"))).toMatch(/your rules|drop or raise/);
    const unpriced = { ...before, actions: before.actions.map((a) => (a.id === "record_order" ? { id: a.id, tool: a.tool, description: a.description } : a)) };
    expect(weakens(before, unpriced)).toBe("It would spend without counting it against your limits.");
  });

  it("is turned down when it would change the maker's rules, schedule or answers, unless it is their own answer", () => {
    const given = { ...price, settings: price.settings.map((s) => (s.key === "target_price" ? { ...s, given: "50" } : s)) };
    const moved = { ...given, settings: given.settings.map((s) => (s.key === "target_price" ? { ...s, given: "60" } : s)) };
    expect(weakens(given, moved)).toBe("It would change an answer you gave, which only you change.");
    expect(weakens(given, moved, { theirs: true })).toBeNull();
    const later = { ...price, triggers: [{ kind: "schedule" as const, every: "day" as const, at: "07:00", description: "Every day at 7:00" }] };
    expect(weakens(price, later)).toBe("It would change when it runs, which only you change.");
    const rules = spending("approval_over_usdc");
    expect(weakens(rules, { ...rules, rules: rules.rules.map((r) => ({ ...r, value: "200" })) })).toBe("It would change your rules, which only you change.");
  });

  it("is turned down when it would raise what one run may do", () => {
    expect(weakens(price, { ...price, limits: { ...price.limits, maxSpendUsd: 0.5 } })).toBe("It would raise the limits on what one run may do.");
    expect(weakens(price, { ...price, limits: { ...price.limits, maxSteps: 200 } })).toBe("It would raise the limits on what one run may do.");
  });

  it("can't pass a test by making the check it failed stop applying", () => {
    // The hackathon checker keeps its place by marking rows; a repair that
    // no longer writes into them would leave "skips what it did" behind.
    const hackathon = definitionOf(NESTED_HACKATHON_WIRE);
    const unmarked = { ...hackathon, actions: hackathon.actions.filter((a) => a.tool !== "sheets.update"), steps: hackathon.steps.map((s) => (s.kind === "action" && hackathon.actions.find((a) => a.id === s.action)?.tool === "sheets.update" ? { ...s, action: hackathon.actions.find((a) => a.tool === "telegram.send")!.id } : s)) };
    expect(weakens(hackathon, unmarked, { failed: "second_run" })).toBe("It would pass its test by making the check it failed stop applying.");
    // An agent that never asked anything keeps nothing it could lose.
    const motivation = definitionOf(MOTIVATION_WIRE);
    expect(weakens(motivation, motivation, { failed: "did_job" })).toBeNull();
  });

  it("may take out a question of the plan's own before a payment: the payment's own approval always asks", () => {
    const paying: AgentDefinition = {
      ...price,
      actions: [...price.actions.filter((a) => a.id !== "send_reminder"), { id: "pay", tool: "wallet.pay", description: "Pay the designer" }],
      steps: price.steps.map((s) => (s.id === "send" && s.kind === "action" ? { ...s, action: "pay" } : s)),
    };
    const noQuestion = without(paying, ["make_question", "ask", "said_yes"], { make_question: "make_reminder" });
    expect(heldByYes(paying)).toEqual([]);
    expect(weakens(paying, noQuestion)).toBeNull();
  });
});
