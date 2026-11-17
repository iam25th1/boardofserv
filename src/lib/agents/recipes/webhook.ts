import type { AgentDefinition } from "../definition";
import { emptyBench } from "../types";
import { literal, type Recipe, type RecipeFill } from "./types";

// An inbound post handler: each time another app posts to the agent's own
// address (runtime/hooks.ts), SERV reads what was posted and writes the
// owner one short message about it (PR #8's webhook trigger, as its live
// test drove it). The trigger is only ever one the maker asked for.

const readCode = [
  "async function run(input) {",
  "  const t = input.trigger || {};",
  "  const body = t.body === undefined ? t : t.body;",
  '  if (body === null || body === undefined || (typeof body === "object" && !Object.keys(body).length) || (typeof body === "string" && !body.trim())) return { post: null };',
  '  return { post: { body: body, at: String(t.at || "") } };',
  "}",
].join("\n");

const tellCode = (task: string) =>
  [
    "async function run(input, tools) {",
    "  if (!input.post) return { message: null };",
    "  const said = await tools.serv.reason({",
    `    task: ${literal(task)},`,
    "    data: input.post,",
    '    answer: { text: "text" },',
    "  });",
    '  return { message: { text: String(said.text || "").slice(0, 3500) } };',
    "}",
  ].join("\n");

export const webhook: Recipe = {
  id: "webhook",
  rev: 1,
  fits: "when another app posts to the agent's own address (a webhook: a payment, a form, a build, a sign-up), have SERV read what was posted and send the owner one short message about it",
  asks: {},
  uses: ["webhook"],
  variants: [],
  task: { says: "what SERV writes about each post, in the maker's terms", byDefault: () => "Read what was posted and tell the owner in two or three plain sentences what happened and anything that needs them." },
  build(f: RecipeFill) {
    return {
      definition: {
        format: 1,
        name: f.name,
        job: { does: f.does, done: f.done },
        triggers: [f.trigger.kind === "webhook" ? f.trigger : { kind: "webhook", description: "When another app posts to it" }],
        settings: [],
        rules: [],
        memory: [],
        steps: [
          { id: "read_post", kind: "code", title: "Read what was posted", plain: "Take what was posted to its address.", description: "Take what was posted to the agent's address from trigger.body. Return post { body, at }, or null when nothing was posted.", inputs: ["trigger"], outputs: ["post"], shapes: { post: "{ body: record, at: text }" }, tools: [], next: "write_message" },
          {
            id: "write_message",
            kind: "code",
            title: "Write you a message about it",
            plain: "Ask SERV to tell you in a few lines what was posted.",
            description: "Ask SERV with serv.reason to write a short message for the owner about the post, with answer { text: text }. Return message, telegram.send's arguments { text }.",
            inputs: ["post"],
            outputs: ["message"],
            shapes: { message: "{ text: text }" },
            tools: ["serv.reason"],
            next: "send",
          },
          { id: "send", kind: "action", title: "Send it to you", plain: "Send it to you on Telegram.", action: "tell", inputs: ["message"], outputs: [], next: null },
        ],
        actions: [{ id: "tell", tool: "telegram.send", description: "Send you a message about each post" }],
        limits: { maxSteps: 20, maxRunSeconds: 120, maxSpendUsd: 0.05 },
      },
      code: { read_post: readCode, write_message: tellCode(f.task) },
    };
  },
  sample(_d: AgentDefinition) {
    const bench = emptyBench();
    bench.trigger = { kind: "webhook", body: { event: "order.paid", order: "1042", customer: "Ada Lin", total: 48.5, currency: "USD" }, at: new Date().toISOString() };
    return { bench, items: { noun: "post", plural: "posts", labels: ["order.paid 1042"] } };
  },
};
