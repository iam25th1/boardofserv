import { describe, expect, it } from "vitest";
import { checkAnswers, settingValue, validTimezone } from "./settingsForm";
import type { AgentDefinition } from "./definition";

// The form an owner fills in to run an agent: each answer checked against
// its question's type, rules over the maker's defaults, and the limits.

const d: Pick<AgentDefinition, "settings" | "rules" | "triggers"> = {
  settings: [
    { key: "stock_sheet", label: "Stock sheet", type: "sheet", help: "x", choices: [] },
    { key: "page", label: "Price page", type: "url", help: "x", choices: [] },
    { key: "fabrics", label: "Fabrics", type: "list", help: "x", choices: [] },
    { key: "size", label: "Size", type: "choice", help: "x", choices: ["Small", "Large"] },
    { key: "weekends", label: "Weekends too", type: "boolean", help: "x", choices: [] },
    { key: "minimum", label: "Minimum", type: "number", help: "x", choices: [] },
  ],
  rules: [
    { key: "approval_over_usdc", label: "Ask over", type: "usdc", value: "250", help: "x" },
    { key: "verbose", label: "Verbose", type: "boolean", value: "false", help: "x" },
  ],
  triggers: [{ kind: "schedule", every: "week", at: "08:00", description: "x" }],
};

describe("the settings form", () => {
  it("takes good answers, typed as the agent's code will read them", () => {
    const r = checkAnswers(d, {
      settings: { stock_sheet: " Stock ", page: "https://suppliers.example/prices", fabrics: "Linen, Felt ,", size: "Large", weekends: true, minimum: "12" },
      rules: { approval_over_usdc: "", verbose: "true" },
      timezone: "Europe/Paris",
      schedule: { at: "07:30", day: 5 },
    });
    expect(r).toEqual({
      ok: true,
      settings: { stock_sheet: "Stock", page: "https://suppliers.example/prices", fabrics: ["Linen", "Felt"], size: "Large", weekends: true, minimum: 12 },
      rules: { approval_over_usdc: "250", verbose: "true" },
      timezone: "Europe/Paris",
      schedule: { at: "07:30", day: 5 },
      minGapMinutes: 5,
      dailySpendUsd: 0.5,
    });
  });

  it("says what is wrong with each answer, by field", () => {
    const r = checkAnswers(d, {
      settings: { stock_sheet: "", page: "file:///etc/passwd", fabrics: "", size: "Huge", minimum: "lots" },
      rules: { approval_over_usdc: "-5", verbose: "maybe" },
      timezone: "Mars/Olympus",
      schedule: { at: "25:00", day: 1 },
      minGapMinutes: 5000,
      dailySpendUsd: 50,
    });
    expect(r).toEqual({
      ok: false,
      errors: {
        stock_sheet: "Give the sheet's name.",
        page: "Give a web address starting with http:// or https://.",
        fabrics: "Give at least one, separated by commas.",
        size: "Pick one of: Small, Large.",
        minimum: "Answer with a number.",
        "rule:approval_over_usdc": "Give an amount in USDC.",
        "rule:verbose": "Answer yes or no.",
        timezone: "Pick a time zone.",
        schedule: "Give a time like 07:30.",
        minGapMinutes: "Give whole minutes, up to a day (1440).",
        dailySpendUsd: "Give an amount from 0 to 5 US dollars.",
      },
    });
  });

  it("knows a time zone, and a missing yes-or-no is a no", () => {
    expect(validTimezone("America/New_York")).toBe(true);
    expect(validTimezone("UTC")).toBe(true);
    expect(validTimezone("")).toBe(false);
    expect(settingValue(d.settings[4]!, undefined)).toEqual({ value: false });
  });
});
