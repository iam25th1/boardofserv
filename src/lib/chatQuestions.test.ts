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
    expect(ASKED_FIELDS).toEqual(["wakes", "looks", "handles"]);
    // What counts as done and what it asks first are kept when said, never
    // asked: a first-time maker can't answer them, and asking invites
    // made-up questions to the owner.
    expect(SKETCH_SCHEMA.schema.properties.asking.description).toContain("never finish, asks, setup or remembers");
    expect(SKETCH_SCHEMA.schema.properties.asks.description).toContain("Never asked, never guessed");
    // Asked anyway, setup is dropped: nothing is asked and no chips show.
    const asked = parseSketchBlock(JSON.stringify({ name: "Checker", kind: "agent", asking: "setup", choices: ["Google Sheet ID"] }))!;
    expect(mergeSketch(null, asked).asking).toBeNull();
  });

  it("never ask for tokens, keys or passwords", () => {
    expect(SYSTEM_PROMPT).toContain("Never ask for accounts, sheet links or IDs, tokens, keys or passwords");
    expect(SYSTEM_PROMPT).toContain("they connect Google Sheets, Telegram and the rest in the chat afterwards, step by step");
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

describe("what the chat says about an agent", () => {
  it("never claims it changed, built, tested, set up or published it, or points at a Plan button", () => {
    for (const said of ["I've updated the plan. Hit Plan again.", "I have changed the steps for you.", "I tested it and it works.", "Press the Plan button to rebuild it.", "I just published it.", "Your price watcher is all set!", "It's ready to go.", "I've set it up for you."]) {
      expect(claimsTooMuch(said), said).toBe(true);
      expect(honestReply(said)).toBe(HONEST_REPLY);
    }
    for (const said of ["It checks every 15 minutes.", "It writes Status and Reasons into each row.", "What should change?"]) expect(honestReply(said)).toBe(said);
  });

  it("keeps what is true and leaves out only the sentence that claims too much", () => {
    expect(honestReply("Got it: every day it reads the page and asks you on Telegram when the price is below your target. Your price watcher is all set!", "x")).toBe("Got it: every day it reads the page and asks you on Telegram when the price is below your target.");
  });

  it("keeps the maker's own numbers and conditions, and plain words", () => {
    expect(SYSTEM_PROMPT).toContain("Keep the person's own numbers, conditions and schedule exactly as they said them");
    expect(SYSTEM_PROMPT).toContain("say steps, never plan, decision, code, tool, settings, draft or version");
    expect(PLAN_PROMPT).toContain("keeping their numbers, conditions and schedule exactly as they said them");
  });
});

describe("a plan that doesn't come together", () => {
  it("says why in plain words and what to add, never the checker's own words", () => {
    expect(planFailure(['the check trigger\'s step "check_new_submissions" is not a step'])).toBe(
      "I couldn't work out the steps: it tried to start when a value changes instead of on a clock. Say how often it should run, for example every 15 minutes.",
    );
    const live = planFailure([
      'step "record_rejections" takes record_rejection (sheets.write) with "rejection_write_records", which other steps read too: give it a value of its own, made by a code step as sheets.write\'s arguments',
      'the check step "trigger_check_submissions" can\'t also be a step of the run',
      'step "load_submissions" can\'t be reached from the first step',
    ]);
    expect(live).toMatch(/^I couldn't work out the steps: .*\. Say /);
    expect(live).not.toMatch(/record_rejection|trigger_check|load_submissions|sheets\.write/);
    expect(planFailure(["something new"])).toBe("I couldn't work out the steps: its steps didn't fit together. Add a detail, like where it finds things, what it decides, and what it writes or sends.");
  });
});
