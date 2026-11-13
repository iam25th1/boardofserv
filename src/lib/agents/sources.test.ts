import { describe, expect, it } from "vitest";
import { checkDefinition } from "./definition";
import { planProblems } from "./planRules";
import { sourceAsk, sourceProblem, unreadableIn } from "./sources";
import { MockTools, ToolError } from "./toolbox";
import { emptyBench } from "./types";

// Honest sources: a form's public link opens the form, not the answers,
// and a page behind a sign-in shows the sign-in. The live scorer "read" a
// Typeform link in 5 ms and scored the link itself.

describe("a link an agent can't read", () => {
  it("is known for what it is", () => {
    expect(sourceProblem("https://form.typeform.com/to/AbC123xy")?.what).toBe("a Typeform form link");
    expect(sourceProblem("https://acme.typeform.com/to/AbC123xy")?.what).toBe("a Typeform form link");
    expect(sourceProblem("https://forms.gle/x1y2z3")?.what).toBe("a Google Forms form link");
    expect(sourceProblem("https://docs.google.com/forms/d/e/1FAIpQ/viewform")?.what).toBe("a Google Forms form link");
    expect(sourceProblem("https://tally.so/r/w4xyz")?.what).toBe("a Tally form link");
    expect(sourceProblem("https://docs.google.com/document/d/1abc/edit")?.what).toBe("a Google Docs page");
    expect(sourceProblem("https://www.linkedin.com/in/someone")?.what).toBe("a page behind a sign-in");
  });

  it("leaves pages and sheets it can read alone", () => {
    expect(sourceProblem("https://shop.example/kettle")).toBeNull();
    expect(sourceProblem("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd")).toBeNull();
    expect(sourceProblem("https://docs.google.com/spreadsheets/d/1abc/edit#gid=0")).toBeNull();
    expect(sourceProblem("not a link")).toBeNull();
  });

  it("is found in what the maker said, and answered in plain words that ask for what's needed", () => {
    const found = unreadableIn("Score submissions from https://form.typeform.com/to/AbC123xy, please.");
    expect(found?.url).toBe("https://form.typeform.com/to/AbC123xy");
    const ask = sourceAsk(found!.problem, "/app/chat?c=abc");
    expect(ask).toContain("I need your Typeform personal token: connect Typeform");
    expect(ask).toContain("Google Sheets");
    // One tap to connect it, coming back to the same chat.
    expect(ask).toContain("[Connect Typeform](/app/connections?connect=typeform&back=%2Fapp%2Fchat%3Fc%3Dabc)");
    // Once Typeform is connected, the link is one an agent can read.
    expect(unreadableIn("Score submissions from https://form.typeform.com/to/AbC123xy", new Set(["typeform"]))).toBeNull();
    expect(unreadableIn("Score submissions from https://forms.gle/x1y2z3", new Set(["typeform"]))?.problem.what).toBe("a Google Forms form link");
  });
});

describe("a step that tries to read one", () => {
  it("fails on the bench as it would for real: nothing read, nothing pretended", async () => {
    const mock = new MockTools({ ...emptyBench(), pages: { "https://form.typeform.com/to/AbC123xy": "Made-up answers" } });
    await expect(mock.call("web.fetch", { url: "https://form.typeform.com/to/AbC123xy" })).rejects.toBeInstanceOf(ToolError);
    await expect(mock.call("web.fetch", { url: "https://form.typeform.com/to/AbC123xy" })).rejects.toThrow("It can't read this with web.fetch: A Typeform link opens the form");
  });

  it("is never planned as one that reads with no tool and nothing to read", () => {
    const c = checkDefinition({
      format: 1,
      name: "Scorer",
      job: { does: "Scores submissions.", done: "Scored." },
      triggers: [{ kind: "schedule", every: "day", at: "09:00", description: "Every day" }],
      settings: [{ key: "typeform_url", label: "Your Typeform link", type: "url", help: "The form.", choices: [] }],
      rules: [],
      memory: [],
      steps: [
        { id: "read", title: "Read Typeform submission", kind: "code", inputs: ["settings"], outputs: ["submission"], description: "Return submission from settings.typeform_url.", tools: [], next: "send" },
        { id: "send", title: "Send", kind: "action", action: "tell", inputs: ["submission"], outputs: [], next: null },
      ],
      actions: [{ id: "tell", tool: "telegram.send", description: "Tell you" }],
      limits: { maxSteps: 5, maxRunSeconds: 30, maxSpendUsd: 0.1 },
    });
    if (!c.ok) throw new Error(c.errors.join("; "));
    expect(planProblems(c.definition)).toEqual([expect.stringContaining('code step "read" says it reads ("Read Typeform submission") but has no tool that reads')]);
  });
});
