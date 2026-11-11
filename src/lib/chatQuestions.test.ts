import { describe, expect, it } from "vitest";
import { mergeSketch, parseSketchBlock, safeChoices, SECRET_CHOICE } from "./sketchBlock";
import { ASKED_FIELDS, fieldsOf } from "./sketchFields";
import { PLAN_PROMPT, SYSTEM_PROMPT } from "./systemPrompt";
import { SKETCH_SCHEMA } from "./sketchPlan";
import { claimsTooMuch, honestReply, HONEST_REPLY } from "./replyClaims";
import { planFailure } from "./agents/plainWords";

// What the chat asks, and what it offers as chips: only what it needs to
// understand the job, never anything secret, and chips that answer the
// question just asked. And what it says about an agent with steps: never
// that it changed anything it didn't.

describe("the chat's questions", () => {
  it("are only about the job: what the owner sets up and what it remembers are never asked", () => {
    expect(fieldsOf("agent")).toEqual(ASKED_FIELDS);
    expect(ASKED_FIELDS).not.toContain("setup");
    expect(ASKED_FIELDS).not.toContain("remembers");
    expect(SKETCH_SCHEMA.schema.properties.asking.description).toContain("never setup or remembers");
    // Asked anyway, setup is dropped: nothing is asked and no chips show.
    const asked = parseSketchBlock(JSON.stringify({ name: "Checker", kind: "agent", asking: "setup", choices: ["Google Sheet ID"] }))!;
    expect(mergeSketch(null, asked).asking).toBeNull();
  });

  it("never ask for tokens, keys or passwords", () => {
    expect(SYSTEM_PROMPT).toContain("Never ask for accounts, sheet links or IDs, tokens, keys or passwords");
    expect(SYSTEM_PROMPT).toContain("guided setup");
    expect(PLAN_PROMPT).toContain("never accounts, IDs, tokens, keys or passwords");
  });
});

describe("chips", () => {
  it("never offer an account, a link or ID, a token, a key or a password", () => {
    for (const secret of ["Google Sheet ID", "Telegram bot token", "API key", "My password", "The sheet link", "My account", "Webhook URL"]) expect(secret).toMatch(SECRET_CHOICE);
    expect(safeChoices(["Google Sheet ID, where requirements live, Telegram bot token", "A Google sheet", "Telegram bot token", "A form"])).toEqual(["A Google sheet", "A form"]);
  });

  it("are a few short words each, at most four, no repeats", () => {
    expect(safeChoices(["Every 15 minutes", "every 15 minutes ", "Every 15 minutes", "Once an hour", "Every morning", "At noon", "At night"])).toEqual(["Every 15 minutes", "every 15 minutes", "Once an hour", "Every morning"]);
    expect(safeChoices(["Whenever a new row shows up in the submissions sheet and it has a demo link"])).toEqual([]);
    expect(parseSketchBlock(JSON.stringify({ choices: ["Every 15 minutes", "Telegram bot token"] }))!.choices).toEqual(["Every 15 minutes"]);
  });
});

describe("what the chat says about an agent with steps", () => {
  it("never claims it changed, tested or published it, or points at a Plan button", () => {
    for (const said of ["I've updated the plan. Hit Plan again.", "I have changed the steps for you.", "I tested it and it works.", "Press the Plan button to rebuild it.", "I just published it."]) {
      expect(claimsTooMuch(said), said).toBe(true);
      expect(honestReply(said)).toBe(HONEST_REPLY);
    }
    for (const said of ["It checks every 15 minutes.", "It writes Status and Reasons into each row.", "What should change?"]) expect(honestReply(said)).toBe(said);
  });
});

describe("a plan that doesn't come together", () => {
  it("says why in plain words and what to add, never the checker's own words", () => {
    expect(planFailure(['the check trigger\'s step "check_new_submissions" is not a step'])).toBe(
      "The plan didn't come together: it tried to start when a value changes instead of on a clock. Say how often it should run, for example every 15 minutes.",
    );
    const live = planFailure([
      'step "record_rejections" takes record_rejection (sheets.write) with "rejection_write_records", which other steps read too: give it a value of its own, made by a code step as sheets.write\'s arguments',
      'the check step "trigger_check_submissions" can\'t also be a step of the run',
      'step "load_submissions" can\'t be reached from the first step',
    ]);
    expect(live).toMatch(/^The plan didn't come together: .*\. Say /);
    expect(live).not.toMatch(/record_rejection|trigger_check|load_submissions|sheets\.write/);
    expect(planFailure(["something new"])).toBe("The plan didn't come together: its steps didn't fit together. Add a detail in the chat, like where it finds things, what it decides, and what it writes or sends.");
  });
});
