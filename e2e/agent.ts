import { readFileSync } from "node:fs";
import type { BrowserContext } from "@playwright/test";

// A planned agent for the browser tests, answered here: the hackathon
// submission checker (hackathon.json, frozen from src/test/hackathonFixture.ts
// with its self test's story), its chat, and what its card and page ask
// the server for. Nothing reaches a model.

type Problem = { text: string; step: string | null; fix: "rewrite" | "replan" | "plan" } | null;
type Step = { id: string; title: string; kind: "code" | "decision" | "action"; next?: string | null; outcomes?: { next: string | null }[]; otherwise?: string | null };

type Frozen = {
  definition: { name: string; steps: unknown[] };
  code: Record<string, { source: string | null }>;
  bench: unknown;
  story: string;
};
const hackathon = JSON.parse(readFileSync(new URL("./hackathon.json", import.meta.url), "utf8")) as Frozen;

export const AGENT_ID = "a1";
export const STORY = hackathon.story;
const steps = hackathon.definition.steps as Step[];

function summary(o: { problem?: Problem; tested?: boolean; state?: "draft" | "published"; buildState?: string }) {
  return {
    id: AGENT_ID,
    version: 1,
    state: o.state ?? "draft",
    buildState: o.buildState ?? "idle",
    buildNote: null,
    steps: steps.map((s) => ({
      id: s.id,
      title: s.title,
      kind: s.kind,
      next: s.kind === "decision" ? (s.outcomes ?? []).map((x) => x.next) : [s.next ?? null],
      code: s.kind === "code" ? (o.problem?.step === s.id ? "needs_attention" : "approved") : null,
    })),
    test: o.tested ? { status: "passed", story: STORY, checkedAt: "2026-11-11T09:00:00.000Z" } : null,
    problem: o.problem ?? null,
  };
}

function builder(o: { problem?: Problem; tested?: boolean; state?: "draft" | "published" }) {
  return {
    agent: summary(o),
    name: hackathon.definition.name,
    conversationId: "c1",
    definition: hackathon.definition,
    code: Object.fromEntries(Object.entries(hackathon.code).map(([id, c]) => [id, { status: o.problem?.step === id ? "needs_attention" : "approved", source: c.source, rounds: 1, note: o.problem?.step === id ? "It counts only the last submission." : null, writer: "dolphin" }])),
    bench: hackathon.bench,
    versions: [{ number: 1, state: o.state ?? "draft", createdAt: "2026-11-11T08:00:00.000Z", publishedAt: null }],
    runnable: null,
    listing: null,
    review: null,
  };
}

export const HELD: Problem = { text: '"Count and mark" didn\'t pass SERV\'s check of its code, so it\'s on hold.', step: "tally", fix: "rewrite" };

// What the page and the card do, as the server answers them. The asked
// list keeps each call the page made, for the tests to check.
export async function withHackathon(context: BrowserContext, start: { problem?: Problem; tested?: boolean } = {}): Promise<{ asked: { url: string; body: unknown }[] }> {
  let now = { ...start };
  const asked: { url: string; body: unknown }[] = [];
  const note = (url: string, body: unknown) => asked.push({ url: new URL(url).pathname, body });
  await context.route("**/api/conversations", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: { conversations: [{ id: "c1", title: "Check my hackathon submissions every 15 minutes", sketchName: hackathon.definition.name, publishedSlug: null, createdAt: "2026-11-11T08:00:00.000Z", updatedAt: new Date().toISOString() }] } })
      : route.fallback(),
  );
  await context.route("**/api/conversations/c1/messages", (route) =>
    route.fulfill({
      json: {
        messages: [
          { id: "m1", conversationId: "c1", role: "user", content: "Check my hackathon submissions every 15 minutes, judge each requirement, reject when fewer than half are met, write Status and Reasons into the row and send me a summary.", createdAt: "2026-11-11T08:00:00.000Z" },
          { id: "m2", conversationId: "c1", role: "assistant", content: "Got it. It's planned: its card shows what it does, and you can test it from there.", createdAt: "2026-11-11T08:01:00.000Z" },
        ],
        sketch: { name: hackathon.definition.name, kind: "agent", watches: null, when: null, how: null, tells: null, takes: null, does: null, gives: null, wakes: "every 15 minutes", looks: "the submissions sheet", handles: "judges each requirement", finish: "every new row has a Status", asks: "nothing", setup: null, remembers: null, asking: null, live: false, kindChosen: true },
        published: null,
        agent: summary(now),
      },
    }),
  );
  await context.route(`**/api/agents/${AGENT_ID}?view=builder`, (route) => route.fulfill({ json: { builder: builder(now) } }));
  await context.route(`**/api/agents/${AGENT_ID}`, (route) => route.fulfill({ json: { agent: summary(now) } }));
  await context.route(`**/api/agents/${AGENT_ID}/jobs`, (route) => route.fulfill({ json: { jobs: [] } }));
  await context.route(`**/api/agents/${AGENT_ID}/test`, (route) => {
    note(route.request().url(), null);
    now = { ...now, tested: true };
    return route.fulfill({ json: { test: { status: "passed", story: STORY, problems: [], items: null, kind: "manual", checkedAt: "2026-11-11T09:00:00.000Z" }, agent: summary(now) } });
  });
  await context.route(`**/api/agents/${AGENT_ID}/fix`, (route) => {
    note(route.request().url(), route.request().postDataJSON());
    now = { ...now, problem: null };
    return route.fulfill({ status: 202, json: { agent: summary(now) } });
  });
  await context.route(`**/api/agents/${AGENT_ID}/publish`, (route) => {
    note(route.request().url(), null);
    return route.fulfill({ json: { builder: builder({ ...now, state: "published" }) } });
  });
  await context.route("**/api/account/details", (route) => {
    note(route.request().url(), route.request().postDataJSON());
    return route.fulfill({ json: { agentDetails: (route.request().postDataJSON() as { on: boolean }).on } });
  });
  return { asked };
}
