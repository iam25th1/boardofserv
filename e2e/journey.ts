import { readFileSync } from "node:fs";
import type { BrowserContext, Route } from "@playwright/test";

// The whole journey in the chat for the browser tests, answered here as
// the server would answer it: the price watcher (price.json, frozen from
// src/test/suiteFixtures.ts with its self test's story), described in one
// message, its steps worked out, changed, built step by step, tried,
// connected and run. Every look at the conversation moves a step on, the
// way the background build does. Nothing reaches a model.

type Line = { id: string; text: string; depth: number };
type Frozen = {
  definition: { name: string; job: { does: string }; triggers: unknown[]; settings: { key: string; label: string; type: string; help: string; choices: string[] }[]; rules: unknown[]; steps: { id: string; title: string; kind: string; next?: string | null; outcomes?: { next: string | null }[]; otherwise?: string | null; body?: string }[] };
  code: Record<string, { source: string }>;
  bench: unknown;
  plain: Line[];
  story: string;
};
const price = JSON.parse(readFileSync(new URL("./price.json", import.meta.url), "utf8")) as Frozen;

export const ASK = "Every day, check a product page I give you and read its price. If the price is below a target I set, ask me on Telegram whether I want a reminder to buy it, and only send the reminder if I say yes.";
export const REPLY = "Every day it reads the price on your product page and, when it's below your target, asks you on Telegram whether to send a reminder, sending it only if you say yes.";
export const FAILED = '"Write the reminder" didn\'t work on the sample product.';
const AGENT = "a9";
const CONVO = "c9";

type Card = { stage: string; agentId?: string; snapshot?: Record<string, unknown>; answers?: unknown; live?: { installationId?: string; listed?: boolean } };
type Msg = { id: string; conversationId: string; role: "user" | "assistant"; content: string; source: string | null; sourceLabel: string | null; card: Card | null; createdAt: string };

export interface Journey {
  // Each call the page made to the server, in order.
  asked: { url: string; method: string; body: unknown }[];
}

export async function withJourney(context: BrowserContext, o: { failFirstTest?: boolean } = {}): Promise<Journey> {
  const asked: Journey["asked"] = [];
  const messages: Msg[] = [];
  let sketch: Record<string, unknown> | null = null;
  let lines: Line[] = [];
  let build: "idle" | "planning" | "fixing" | "writing" = "idle";
  // Each code step's progress, in the order a run takes them.
  const codeSteps = price.definition.steps.filter((s) => s.kind === "code").map((s) => s.id);
  let code: Record<string, string> = Object.fromEntries(codeSteps.map((id) => [id, "queued"]));
  let test: { status: "passed" | "failed"; story: string } | null = null;
  let testing = false;
  let failing = Boolean(o.failFirstTest);
  let ticks = 0;
  let then: (() => void) | null = null;
  let n = 0;
  const stamp = () => new Date(Date.UTC(2026, 10, 11, 9, 0, n++)).toISOString();

  const say = (role: Msg["role"], content: string, card: Card | null = null) => messages.push({ id: `m${n}`, conversationId: CONVO, role, content, source: role === "assistant" && !card ? "serv" : null, sourceLabel: role === "assistant" && !card ? "SERV" : null, card, createdAt: stamp() });
  // A new stage's card; the one before keeps what it showed.
  const addCard = (stage: string, content: string) => {
    const before = [...messages].reverse().find((m) => m.card);
    if (before?.card && !before.card.snapshot) {
      before.card.snapshot =
        before.card.stage === "steps" ? { lines } : before.card.stage === "build" ? { note: "Built and checked" } : before.card.stage === "try" ? (test ? { status: test.status, story: test.story, problem: test.status === "failed" ? FAILED : null } : {}) : before.card.stage === "describe" ? { lines: describedLines() } : {};
    }
    say("assistant", content, { stage, agentId: stage === "describe" ? undefined : AGENT });
  };
  const describedLines = () => (sketch ? (["wakes", "looks", "handles"] as const).map((k) => ({ id: k, text: String(sketch![k]), depth: 0 })) : []);

  const summary = () => ({
    id: AGENT,
    version: 1,
    state: "draft",
    buildState: build,
    buildNote: null,
    steps: lines.length
      ? price.definition.steps.map((s) => ({ id: s.id, title: s.title, kind: s.kind, next: s.kind === "decision" ? (s.outcomes ?? []).map((x) => x.next) : [s.next ?? null], code: s.kind === "code" ? code[s.id] : null }))
      : [],
    test: test ? { ...test, checkedAt: "2026-11-11T09:05:00.000Z" } : null,
    problem: test?.status === "failed" ? { text: FAILED, step: "make_reminder", fix: "replan" } : null,
    plain: lines,
    setup: { name: price.definition.name, settings: price.definition.settings, rules: price.definition.rules, triggers: price.definition.triggers, needs: { telegram: true, google: false }, spends: false, given: { product_url: "https://shop.example/kettle", target_price: "50" } },
    does: price.definition.job.does,
  });

  // The background build, one move a look.
  const tick = () => {
    if (build === "planning" || build === "fixing") {
      if (++ticks < 2) return;
      ticks = 0;
      if (!lines.length) lines = price.plain;
      build = "idle";
      const after = then;
      then = null;
      after?.();
      return;
    }
    if (build !== "writing") return;
    if (testing) {
      testing = false;
      build = "idle";
      if (failing) {
        failing = false;
        test = { status: "failed", story: 'It read the page and asked you on Telegram "The price is now 42, at or below your target of 50. Send you a reminder to buy it? http..." (you answered "Yes"), then it stopped at "Write the reminder".' };
      } else {
        test = { status: "passed", story: price.story };
        addCard("connect", "Connecting it to what it needs.");
      }
      return;
    }
    const next = codeSteps.find((id) => code[id] !== "approved");
    if (next) {
      code[next] = code[next] === "queued" ? "writing" : code[next] === "writing" ? "reviewing" : "approved";
      return;
    }
    addCard("try", "Trying it on a sample.");
    testing = true;
  };
  const startBuild = () => {
    build = "writing";
    test = null;
  };

  const conversations = () =>
    messages.length ? [{ id: CONVO, title: "Every day, check a product page I give you and read its price", sketchName: sketch ? "Price watcher" : null, publishedSlug: null, createdAt: messages[0]!.createdAt, updatedAt: messages.at(-1)!.createdAt }] : [];
  const note = (route: Route) => {
    const r = route.request();
    asked.push({ url: new URL(r.url()).pathname, method: r.method(), body: r.postDataJSON() ?? null });
  };
  const sse = (events: [string, unknown][]) => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");

  await context.route("**/api/conversations", (route) => (route.request().method() === "GET" ? route.fulfill({ json: { conversations: conversations() } }) : route.fallback()));
  await context.route(`**/api/conversations/${CONVO}/messages`, (route) => {
    tick();
    return route.fulfill({ json: { messages, sketch, published: null, agent: lines.length || build !== "idle" ? summary() : null } });
  });
  await context.route("**/api/chat", (route) => {
    note(route);
    const said = (route.request().postDataJSON() as { content: string }).content;
    say("user", said);
    sketch = { name: "Price watcher", kind: "agent", watches: null, when: null, how: null, tells: null, takes: null, does: null, gives: null, wakes: "every day", looks: "a product page you give it", handles: "below your target, asks you on Telegram whether to send a reminder, and sends it only on a yes", finish: null, asks: "sending the reminder", setup: null, remembers: null, asking: null, live: false, kindChosen: false };
    say("assistant", REPLY);
    const reply = messages.at(-1)!;
    messages.splice(
      0,
      messages.length,
      ...messages.filter((m) => m.card?.stage !== "describe"),
    );
    addCard("describe", "I have what I need to make it.");
    const card = messages.at(-1)!;
    return route.fulfill({
      contentType: "text/event-stream",
      body: sse([
        ["sketch", { conversationId: CONVO, sketch }],
        ["meta", { conversationId: CONVO, source: "serv", label: "SERV" }],
        ["delta", { text: REPLY }],
        ["reply_end", { messageId: reply.id, source: "serv", label: "SERV", choices: [] }],
        ["card", { conversationId: CONVO, message: { id: card.id, role: "assistant", content: card.content, card: card.card, createdAt: card.createdAt } }],
        ["done", { messageId: reply.id, source: "serv", label: "SERV" }],
      ]),
    });
  });
  await context.route("**/api/agents", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    note(route);
    addCard("steps", "Working out the steps.");
    build = "planning";
    return route.fulfill({ status: 202, json: { agent: summary() } });
  });
  await context.route(`**/api/agents/${AGENT}/fix`, (route) => {
    note(route);
    const body = route.request().postDataJSON() as { message?: string; step?: string; journey?: string };
    say("user", body.message ?? "Write that step again");
    if (body.journey === "fix") {
      addCard("steps", "Changing the steps.");
      then = () => {
        say("assistant", 'I changed the steps. New or changed: "Write the reminder". Gone: "Write the reminder".');
        addCard("build", "Building the changed steps.");
        code = { ...code, make_reminder: "queued" };
        startBuild();
      };
    } else {
      then = () => {
        lines = lines.map((l) => (l.id === "make_reminder" ? { ...l, text: "Write the reminder, with the price in it" } : l));
        say("assistant", 'I changed the steps. New or changed: "Write the reminder, with the price in it". Gone: "Write the reminder".');
      };
    }
    build = "fixing";
    return route.fulfill({ status: 202, json: { agent: summary() } });
  });
  await context.route(`**/api/agents/${AGENT}/build`, (route) => {
    note(route);
    addCard("build", "Building and checking each step.");
    startBuild();
    return route.fulfill({ status: 202, json: { agent: summary() } });
  });
  await context.route(`**/api/conversations/${CONVO}/journey`, (route) => {
    note(route);
    const answers = (route.request().postDataJSON() as { answers: { settings: Record<string, unknown> } }).answers;
    if (!Number.isFinite(Number(answers.settings.target_price)) || String(answers.settings.target_price).trim() === "") {
      return route.fulfill({ status: 400, json: { error: "Some answers need another look.", errors: { target_price: "Give a number." } } });
    }
    const card = [...messages].reverse().find((m) => m.card?.stage === "connect")!;
    card.card!.answers = answers;
    card.content = "Connected: it has what it needs.";
    addCard("live", "Ready to go live.");
    return route.fulfill({ json: { ok: true } });
  });
  await context.route(`**/api/agents/${AGENT}/golive`, (route) => {
    note(route);
    const card = [...messages].reverse().find((m) => m.card?.stage === "live")!;
    const body = route.request().postDataJSON() as { how: string };
    card.card!.live = { ...card.card!.live, ...(body.how === "run" ? { installationId: "i9" } : { listed: true }) };
    return route.fulfill({ json: body.how === "run" ? { installation: installation() } : { listing: { listed: true } } });
  });
  const installation = () => ({ id: "i9", agentId: AGENT, name: "Price watcher", version: 1, status: "active", pausedReason: null, needs: { telegram: true, google: false }, missing: [], timezone: "Europe/London", settings: [], rules: [], minGapMinutes: 60, dailySpendUsd: 1, createdAt: stamp(), runs: ["Runs every day at 9:00."], nextRunAt: "2026-11-12T09:00:00.000Z", takesMessages: false, checkNote: null, memory: [], spending: null, jobs: [] });
  await context.route("**/api/installations/i9", (route) => route.fulfill({ json: { installation: installation() } }));
  await context.route("**/api/connections", (route) => route.fulfill({ json: { connections: [{ provider: "telegram", label: "@maya", createdAt: stamp() }], available: { telegram: true, google: true } } }));
  await context.route(`**/api/agents/${AGENT}`, (route) => route.fulfill({ json: { agent: summary() } }));
  await context.route(`**/api/agents/${AGENT}?view=builder`, (route) =>
    route.fulfill({
      json: {
        builder: {
          agent: summary(),
          name: price.definition.name,
          conversationId: CONVO,
          definition: price.definition,
          code: Object.fromEntries(Object.entries(price.code).map(([id, c]) => [id, { status: "approved", source: c.source, rounds: 1, note: null, writer: "dolphin" }])),
          bench: price.bench,
          versions: [{ number: 1, state: "draft", createdAt: "2026-11-11T09:00:00.000Z", publishedAt: null }],
          runnable: null,
          listing: null,
          review: null,
        },
      },
    }),
  );
  await context.route(`**/api/agents/${AGENT}/jobs`, (route) => route.fulfill({ json: { jobs: [] } }));
  await context.route("**/api/account/details", (route) => route.fulfill({ json: { agentDetails: (route.request().postDataJSON() as { on: boolean }).on } }));
  return { asked };
}
