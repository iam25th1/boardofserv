import "server-only";
import { completeJson, type ChatMessage, type JsonResult, type ModelConfig } from "../model";
import { ANSWER_LIMITS } from "../modelLimits";
import { CATALOG, entryOf, needsConnecting, serviceName, servicesIn } from "../connections/catalog";
import { fixDashes } from "../dashes";
import { PLACEHOLDER_ANSWER } from "./planRepairs";

// Before an agent is planned, Describe asks what the job can't run
// without: what it works on (which repositories, pages, coins), the bar it
// judges by, where its results go. SERV lists them once the job is clear,
// at most three short questions, each with answers to tap, the first a
// default; the chat asks them one at a time and keeps each answer, which
// the planner then makes a setting with that answer (never a value
// written into a step). A service of the catalog the job needs that isn't
// connected is asked about too, with a link to connect it and come back
// here; one the maker named that isn't in the catalog is offered through
// Custom API, or left out. "I have what I need" comes only when every one
// is answered or taken at its default.
//
// The rules go in the request under a one-line system message: SERV's
// gateway cuts answers that restate a system message.

export interface NeedItem {
  key: string;
  // input: something the job works on or by; service: a service of the
  // catalog to connect; unlisted: one the maker named that isn't in it.
  kind: "input" | "service" | "unlisted";
  question: string;
  // What to tap, the default first.
  choices: string[];
  answer: string | null;
  // The service it is about (an id, or for unlisted its name).
  service?: string;
}

export interface JobNeeds {
  items: NeedItem[];
  // The catalog's services the job needs, by id.
  services: string[];
  // The item the chat asked about last, which the maker's next message
  // answers.
  asked: string | null;
  at: string;
}

export const MAX_QUESTIONS = 3;
// When it runs, asked when the maker didn't say: every day by default, a
// post to it only when they pick that.
export const WHEN_KEY = "when";
export const DAILY = "Every day at 9:00";
export const ON_POST = "When another app posts to it";
export const WHEN_CHOICES = [DAILY, "Every hour", "Every Monday at 9:00", ON_POST];
export function whenItem(): NeedItem {
  return { key: WHEN_KEY, kind: "input", question: "When should it run?", choices: WHEN_CHOICES, answer: null };
}
// Tapped on a service's ask: connect it later, at setup.
export const LATER = "Later, when I set it up";
export const CONNECTED_NOW = "I've connected it";
export const USE_CUSTOM = "Use Custom API";
export const LEAVE_OUT = "Leave it out";

const str = (description: string) => ({ type: "string", description });
const strings = (description: string) => ({ type: "array", items: { type: "string" }, description });
export const NEEDS_SCHEMA = {
  name: "agent_needs",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["needs", "services", "unlisted"],
    properties: {
      needs: {
        type: "array",
        description: "what it can't run without, most important first, at most 3",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["key", "question", "choices", "given"],
          properties: {
            key: str("snake_case name for it"),
            question: str("one short plain question"),
            choices: strings("2 to 4 short answers to tap, the first the default"),
            given: str("the maker's own answer if they said it already, exactly as they said it, else empty"),
          },
        },
      },
      services: strings("ids of the listed services the job reads from or sends to"),
      unlisted: strings("names of services the maker named that aren't listed, else []"),
    },
  },
};

export const NEEDS_SYSTEM = "You list what an automated agent needs to know before it is built. Answer with JSON in the given schema.";

export function needsRequest(job: string, said: string[]): string {
  const listed = CATALOG.filter((e) => e.id !== "webhook").map((e) => `${e.id} (${e.name})`).join(", ");
  return [
    "The job, as the maker described it:",
    job,
    "",
    "What the maker said:",
    ...said.map((s) => `- ${s}`),
    "",
    `Services an agent can reach, by id: ${listed}. Messages to the owner go to their own Telegram (telegram) unless they say otherwise.`,
    "",
    `List what this job can't run without, as questions, at most ${MAX_QUESTIONS}, most important first, only from these: what it works on (which repositories, pages, forms, coins, wallets, channels), the bar it judges or compares by (what counts as good enough, a price, a threshold), and where its results go and to whom. Leave out anything the maker already made clear only when they said it exactly; then put their words in given.`,
    'Each question is short and plain, for someone who has never built an agent. choices are 2 to 4 short answers they can tap, the first a sensible default ("Telegram" for where results go); when nothing is a sensible default (which repositories), the first choice is "I\'ll give it at setup".',
    "Never ask about the schedule, accounts, keys, tokens or passwords, or how it works inside.",
    "services: the ids of the services above it reads from or sends to, from what the maker said. unlisted: services the maker named that aren't above, by their names.",
    "Never use em dashes.",
  ].join("\n");
}

const text = (v: unknown, max: number) => (typeof v === "string" ? fixDashes(v.trim()).slice(0, max) : "");
const keyOf = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "need";

// SERV's answer as the job's needs, with the services it needs that the
// owner hasn't connected asked about too, and any service named that isn't
// in the catalog. Null when it isn't an answer.
// askWhen: the maker didn't say when it runs, so that is asked first, as
// one of the three.
export function readNeeds(content: string | null, said: string, connected: ReadonlySet<string>, now = new Date(), o: { askWhen?: boolean } = {}): JobNeeds | null {
  let w: { needs?: { key?: unknown; question?: unknown; choices?: unknown; given?: unknown }[]; services?: unknown; unlisted?: unknown };
  try {
    w = JSON.parse(content ?? "") as typeof w;
  } catch {
    return null;
  }
  if (!Array.isArray(w.needs)) return null;
  const items: NeedItem[] = o.askWhen ? [whenItem()] : [];
  for (const n of w.needs) {
    if (items.length >= MAX_QUESTIONS) break;
    const question = text(n.question, 200);
    if (!question || (o.askWhen && /\b(?:when|how often|schedule|what time)\b/i.test(question))) continue;
    const choices = [...new Set((Array.isArray(n.choices) ? n.choices : []).map((c) => text(c, 60)).filter(Boolean))].slice(0, 4);
    const given = text(n.given, 300);
    let key = keyOf(text(n.key, 40) || question);
    while (items.some((i) => i.key === key)) key = `${key}_2`;
    items.push({ key, kind: "input", question, choices: choices.length ? choices : ["I'll give it at setup"], answer: given || null });
  }
  const services = [...new Set([...(Array.isArray(w.services) ? w.services : []).map((s) => text(s, 30)), ...servicesIn(said)])].filter((id) => entryOf(id) && id !== "webhook");
  const needs: JobNeeds = { items, services, asked: null, at: now.toISOString() };
  for (const name of (Array.isArray(w.unlisted) ? w.unlisted : []).map((u) => text(u, 40)).filter(Boolean).slice(0, 2)) {
    if (servicesIn(name).length) continue;
    needs.items.push({ key: `unlisted_${keyOf(name)}`, kind: "unlisted", question: `${name} isn't one of the services here. An agent can reach it through Custom API: its https address and your key for it, connected on Connections. Or leave it out.`, choices: [USE_CUSTOM, LEAVE_OUT], answer: null, service: name });
  }
  return withServiceAsks(needs, connected);
}

// The services the job needs that the owner hasn't connected, each asked
// about once.
function withServiceAsks(needs: JobNeeds, connected: ReadonlySet<string>): JobNeeds {
  const items = [...needs.items];
  for (const id of needs.services) {
    const e = entryOf(id);
    if (!e || !needsConnecting(e) || connected.has(id) || items.some((i) => i.kind === "service" && i.service === id)) continue;
    items.push({ key: `connect_${id}`, kind: "service", question: `It uses ${e.name}, which isn't connected yet. Connect it now and come back here, or when you set it up.`, choices: [LATER, CONNECTED_NOW], answer: null, service: id });
  }
  return { ...needs, items };
}

export async function listNeeds(job: string, said: string[], connected: ReadonlySet<string>, opts: { config: ModelConfig; signal: AbortSignal; fetchImpl?: typeof fetch; askWhen?: boolean }): Promise<{ needs: JobNeeds | null; call: JsonResult }> {
  const messages: ChatMessage[] = [
    { role: "system", content: NEEDS_SYSTEM },
    { role: "user", content: needsRequest(job, said) },
  ];
  const call = await completeJson(messages, { config: opts.config, purpose: "agent_needs", schema: NEEDS_SCHEMA, maxTokens: ANSWER_LIMITS.agent_needs, signal: opts.signal, fetchImpl: opts.fetchImpl });
  return { needs: readNeeds(call.content, said.join("\n"), connected, new Date(), { askWhen: opts.askWhen }), call };
}

export const openItem = (n: JobNeeds | null): NeedItem | null => n?.items.find((i) => i.answer === null) ?? null;
export const settled = (n: JobNeeds | null): boolean => !openItem(n);

// The maker's answer to the item asked: a tap or their own words. A
// service asked about counts as answered once it is connected, or put off
// to setup; told they connected it when they haven't, it asks again. An
// answer that names a service of the catalog brings it in (and asks to
// connect it).
export function answerItem(n: JobNeeds, said: string, connected: ReadonlySet<string>): JobNeeds {
  const item = n.items.find((i) => i.key === n.asked && i.answer === null) ?? openItem(n);
  if (!item) return n;
  const words = said.trim().slice(0, 300);
  let answer: string | null = words || item.choices[0] || null;
  if (item.kind === "service") {
    if (connected.has(item.service!)) answer = "connected";
    else if (/^(i'?ve )?connected/i.test(words) || words === CONNECTED_NOW) answer = null;
    else answer = LATER;
  }
  if (item.kind === "unlisted") answer = /custom/i.test(words) ? USE_CUSTOM : LEAVE_OUT;
  const items = n.items.map((i) => (i === item ? { ...i, answer } : i));
  const services = [...new Set([...n.services, ...(item.kind === "input" ? servicesIn(words).filter((id) => id !== "webhook") : []), ...(answer === USE_CUSTOM ? ["custom"] : [])])];
  return withServiceAsks({ ...n, items, services, asked: answer === null ? item.key : null }, connected);
}

// What the chat says to ask one: the first time, the inputs it needs, by
// their questions; a service's ask with a link to connect it that comes
// back to this conversation.
export function askText(n: JobNeeds, item: NeedItem, conversationId: string, first: boolean): string {
  const inputs = n.items.filter((i) => i.kind === "input" && i.answer === null);
  const lead = first && inputs.length > 1 ? `Before I make it, I need ${inputs.length === 2 ? "two things" : "three things"} from you. ` : first && inputs.length === 1 ? "Before I make it, one thing. " : "";
  if (item.kind === "input") return `${lead}${item.question}`;
  const back = encodeURIComponent(`/app/chat?c=${conversationId}`);
  if (item.kind === "service") {
    const again = n.asked === item.key ? `${serviceName(item.service!)} isn't connected yet. ` : "";
    return `${lead}${again}${item.question}\n\n[Connect ${serviceName(item.service!)}](/app/connections?connect=${item.service}&back=${back})`;
  }
  return `${lead}${item.question}\n\n[Connect Custom API](/app/connections?connect=custom&back=${back})`;
}

// What the planner is told of the answers: each a setting with that
// answer, a service to reach through Custom API or to leave out.
export function needNotes(n: JobNeeds | null): string[] {
  if (!n) return [];
  const out: string[] = [];
  for (const i of n.items) {
    if (i.key === WHEN_KEY && i.answer) {
      out.push(i.answer === ON_POST ? "The maker was asked when it runs and chose to start it when another app posts to it: its one trigger is of kind webhook." : `The maker was asked when it runs and answered "${i.answer}": that is its one trigger, exactly (a schedule), never a webhook or a check they didn't ask for.`);
      continue;
    }
    if (i.kind === "input" && i.answer) {
      // An answer that names no value ("A specific repository") is asked at setup.
      const later = PLACEHOLDER_ANSWER.test(i.answer.trim());
      out.push(later ? `The maker was asked "${i.question}" and will answer it at setup: it is a setting with no given answer, read by the steps, never written into a step.` : `The maker was asked "${i.question}" and answered "${i.answer}": that is a setting with given "${i.answer}", exactly, read by the steps, never written into a step.`);
    }
    if (i.kind === "unlisted") out.push(i.answer === USE_CUSTOM ? `${i.service} isn't in the catalog: reach it through custom (Custom API) with service.request or service.send, and list "custom" in services.` : `${i.service} isn't in the catalog: leave it out, with no step for it.`);
  }
  if (n.services.length) out.push(`The job uses these services of the catalog, by id: ${n.services.join(", ")}. Plan no step for any other service.`);
  return out;
}
