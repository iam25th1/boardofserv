// @vitest-environment node
import { describe, expect, it } from "vitest";
import { saysWhen, describedEnough } from "../sketchFields";
import { hookAdvice } from "./runtime/hooks";
import { DAILY, needNotes, ON_POST, readNeeds, WHEN_CHOICES, type JobNeeds } from "./needs";
import { checkDefinition, type AgentDefinition } from "./definition";
import { repaired } from "./plan";

// No trigger the owner never asked for: when it runs is theirs to say, and
// when they don't, it is asked with what the job needs, every day by
// default. A post starts it only when they ask for that, and then the chat
// shows its address and where to paste it.

describe("when it runs", () => {
  it("is what the maker said, never what was made of it", () => {
    expect(saysWhen("Every morning at 8, send me a Telegram message")).toBe(true);
    expect(saysWhen("Alert me on Discord when the ETH price drops below 2000 dollars.")).toBe(true);
    expect(saysWhen("Start it when GitHub posts to it")).toBe(true);
    expect(saysWhen("i would like a mini agent that checks githubs and verifies code, work, quality.")).toBe(false);
    // The job is clear without it: it is asked before Make it.
    expect(describedEnough({ kind: "agent", wakes: null, looks: null, handles: "checks code quality" })).toBe(true);
  });

  it("is asked first when the maker didn't say it, every day by default, as one of the three", () => {
    const needs = readNeeds(
      JSON.stringify({
        needs: [
          { key: "schedule", question: "How often should it check?", choices: ["Daily"], given: "" },
          { key: "repos", question: "Which repositories should it check?", choices: ["I'll give it at setup"], given: "" },
          { key: "bar", question: "What counts as good quality?", choices: ["Tested changes"], given: "" },
          { key: "to", question: "Where should results go?", choices: ["Telegram"], given: "" },
        ],
        services: ["github"],
        unlisted: [],
      }),
      "checks githubs",
      new Set(),
      new Date(),
      { askWhen: true },
    )!;
    expect(needs.items.map((i) => i.key)).toEqual(["when", "repos", "bar"]);
    expect(needs.items[0]).toMatchObject({ question: "When should it run?", choices: WHEN_CHOICES });
    expect(WHEN_CHOICES[0]).toBe(DAILY);
  });

  it("reaches the planner as its one trigger, a post only when the maker picked one", () => {
    const n = (answer: string): JobNeeds => ({ items: [{ key: "when", kind: "input", question: "When should it run?", choices: WHEN_CHOICES, answer }], services: [], asked: null, at: "" });
    expect(needNotes(n(DAILY))[0]).toBe('The maker was asked when it runs and answered "Every day at 9:00": that is its one trigger, exactly (a schedule), never a webhook or a check they didn\'t ask for.');
    expect(needNotes(n(ON_POST))[0]).toBe("The maker was asked when it runs and chose to start it when another app posts to it: its one trigger is of kind webhook.");
  });
});

describe("a webhook trigger", () => {
  const plan = (): AgentDefinition => {
    const c = checkDefinition({
      format: 1,
      name: "GitHub Code Verifier",
      job: { does: "Checks new commits for quality and tells the owner.", done: "Told." },
      triggers: [{ kind: "webhook", description: "GitHub webhook triggers on new commits" }],
      settings: [{ key: "repos", label: "Repositories", type: "list", help: "owner/name", choices: [], given: "vercel/next.js" }],
      rules: [],
      memory: [],
      steps: [
        { id: "read", kind: "code", title: "Read commits", description: "Read the commits of settings.repos with github.read and return message, what it found in plain words.", inputs: ["settings"], outputs: ["message"], tools: ["github.read"], next: "send" },
        { id: "send", kind: "action", title: "Tell the owner", action: "tell", inputs: ["message"], outputs: [], next: null },
      ],
      actions: [{ id: "tell", tool: "telegram.send", description: "Tell the owner" }],
      limits: { maxSteps: 20, maxRunSeconds: 60, maxSpendUsd: 0.1 },
    });
    if (!c.ok) throw new Error(c.errors.join("; "));
    return c.definition;
  };

  it("becomes every day at 9:00 when the maker never asked for one, a guess of the chat's or not", () => {
    const d = checkDefinition(repaired(plan(), { owner: "i would like a mini agent that checks githubs and verifies code, work, quality." }));
    expect(d.ok && d.definition.triggers).toEqual([{ kind: "schedule", every: "day", at: "09:00", description: "Every day at 9:00" }]);
  });

  it("stays when the maker asked to be started by a post", () => {
    for (const owner of ["Run it when GitHub sends a webhook for a new push.", `When should it run? ${ON_POST}`]) {
      const d = checkDefinition(repaired(plan(), { owner }));
      expect(d.ok && d.definition.triggers.map((t) => t.kind), owner).toEqual(["webhook"]);
    }
  });

  it("comes with the agent's address and the exact place to paste it in that service", () => {
    const url = "https://boardofserv.25th.dev/api/hooks/abcdefghijklmnopqrstuvwxyz012345";
    expect(hookAdvice(url, "Check my GitHub repo's new pull requests when GitHub posts to it")).toBe(
      `It starts each time something is posted to its own address:\n\n${url}\n\nIn GitHub, open the repository's Settings, then Webhooks, and press Add webhook: paste it as the Payload URL, set Content type to application/json, pick the events to send, and press Add webhook. Keep the address to yourself: anyone with it can start a job.`,
    );
    expect(hookAdvice(url, "Score each new Typeform answer as it comes in")).toContain("In Typeform, open the form's Connect tab, then Webhooks");
    expect(hookAdvice(url, "When my build server posts to it, tell me")).toContain("In the app that sends it, open its webhook settings and paste it as the address it posts to.");
  });
});
