import "server-only";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { conversations, messages, type Agent, type AgentVersion, type Message, type User } from "../db/schema";
import type { CardSnapshot, JourneyCard, PlainLine, Stage } from "../journey";
import { loadSketch } from "../sketchStore";
import { describedEnough } from "../sketchFields";
import { refusal } from "../spend";
import type { AgentSummaryDTO } from "../types";
import { answerQuestion, jobFor, planInputFor, plainSteps, startBuild, startPlan, startRewrite, summaryOf, type BuildContext, type Settle } from "./build";
import { buildContext, NOT_AVAILABLE } from "./context";
import type { AgentDefinition } from "./definition";
import { plain } from "./plainView";
import { problemOf } from "./plainWords";
import { sourceAsk, unreadableIn } from "./sources";
import { hasConnection, secretOf } from "../connections/vault";
import { serverRuntime, type Runtime } from "./runtime/context";
import { formIdOf, formQuestions, typeformLinkIn } from "../typeform/api";
import { agentForConversation, agentsOf, createAgent, currentVersion, editableDraft } from "./store";

// The journey in the chat, on the server (src/lib/journey.ts has the
// stages): each stage's card is a message, put in the conversation as the
// stage starts, and the steps of making an agent run from here so the
// cards follow what really happens. Make it plans the steps and stops for
// the maker to look; Looks right builds and tests them; Change something
// changes them and says what changed; a failed test is fixed from what the
// maker says, running again only the stages it needs.

// The steps in plain words, in the order a run takes them.
export const plainLines = (d: AgentDefinition | null): PlainLine[] => plainSteps(d);

// The steps as words, for a card's text in the conversation's history.
function listed(lines: PlainLine[]): string {
  return lines.map((l, i) => `${"  ".repeat(l.depth)}${i + 1}. ${l.text}`).join("\n");
}

// What a card showed once the journey moved past it.
function snapshotOf(card: JourneyCard, v: AgentVersion | null, sketchLines: PlainLine[]): CardSnapshot {
  const problem = v ? (problemOf(v)?.text ?? null) : null;
  switch (card.stage) {
    case "describe":
      return { lines: sketchLines };
    case "steps":
      return { lines: plainLines(v?.definition ?? null), problem: v?.definition ? null : (v?.buildNote ?? null), ...healedOn(card, v) };
    case "build":
      return { note: problem ? undefined : "Built and checked", problem, ...healedOn(card, v) };
    case "try":
      return { ...(v?.testResult ? { status: v.testResult.status, story: v.testResult.story, problem: v.testResult.problems[0]?.text ?? null } : { problem }), ...healedOn(card, v) };
    default:
      return {};
  }
}

// The lines the build said while it healed itself on this card.
function healedOn(card: JourneyCard, v: AgentVersion | null): Pick<CardSnapshot, "healed"> {
  const lines = (v?.heal?.lines ?? []).filter((l) => !card.at || l.at >= card.at).map(({ text, tone }) => ({ text, tone }));
  return lines.length ? { healed: lines } : {};
}

// What the maker said about the job, as the Describe card lists it.
async function describedLines(conversationId: string): Promise<PlainLine[]> {
  const s = await loadSketch(conversationId);
  if (!s) return [];
  const said = (["wakes", "looks", "handles", "finish", "asks"] as const).flatMap((k) => (s[k] ? [{ id: k, text: s[k]!, depth: 0 }] : []));
  return said;
}

export async function cardsIn(conversationId: string): Promise<Message[]> {
  const rows = await db.select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(asc(messages.createdAt));
  return rows.filter((m) => m.card);
}

async function touch(conversationId: string): Promise<void> {
  await db.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, conversationId));
}

// A new stage's card at the end of the conversation. The card before it, if
// it still shows the agent live, keeps what it shows now.
export async function addCard(conversationId: string, card: JourneyCard, content: string): Promise<Message> {
  const before = (await cardsIn(conversationId)).at(-1);
  if (before?.card && !before.card.snapshot) {
    const agentId = before.card.agentId ?? card.agentId;
    const v = agentId ? await currentVersion(agentId) : null;
    const snapshot = snapshotOf(before.card, v, before.card.stage === "describe" ? await describedLines(conversationId) : []);
    await db.update(messages).set({ card: { ...before.card, snapshot }, content: contentOf(before.card, snapshot) ?? before.content }).where(eq(messages.id, before.id));
  }
  const [row] = await db.insert(messages).values({ conversationId, role: "assistant", content, card: { ...card, at: new Date().toISOString() } }).returning();
  await touch(conversationId);
  return row!;
}

// A card's words once it has a snapshot: what the conversation's history
// says it showed.
function contentOf(card: JourneyCard, s: CardSnapshot): string | null {
  if (card.stage === "steps" && s.lines?.length) return `The steps:\n${listed(s.lines)}`;
  if (card.stage === "build") return s.problem ? `The build stopped: ${s.problem}` : "Built and checked every step.";
  if (card.stage === "try" && s.story) return `Its test: ${s.story}${s.status === "failed" && s.problem ? ` ${s.problem}` : ""}`;
  return null;
}

export async function updateCard(id: string, card: JourneyCard, content?: string): Promise<void> {
  await db.update(messages).set({ card, ...(content ? { content } : {}) }).where(eq(messages.id, id));
}

// A line from the chat, saying what happened.
export async function say(conversationId: string, text: string): Promise<Message> {
  const [row] = await db.insert(messages).values({ conversationId, role: "assistant", content: text }).returning();
  await touch(conversationId);
  return row!;
}

// What the maker typed into a card, kept as their own message.
export async function heard(conversationId: string, text: string): Promise<Message> {
  const [row] = await db.insert(messages).values({ conversationId, role: "user", content: text }).returning();
  await touch(conversationId);
  return row!;
}

// The Describe card goes under the latest reply while the job is still
// being described: one card, never left behind further up.
export async function offerMakeIt(conversationId: string): Promise<Message | null> {
  const cards = await cardsIn(conversationId);
  if (cards.some((m) => m.card?.stage !== "describe")) return null;
  const sketch = await loadSketch(conversationId);
  if (!describedEnough(sketch)) return null;
  if (cards.length) await db.delete(messages).where(inArray(messages.id, cards.map((m) => m.id)));
  const [row] = await db.insert(messages).values({ conversationId, role: "assistant", content: "I have what I need to make it.", card: { stage: "describe" } }).returning();
  return row!;
}

// A value as text with its keys in order, so the same value read back from
// the database (which orders them its own way) reads the same.
function canonical(v: unknown): string {
  const norm = (x: unknown): unknown => (Array.isArray(x) ? x.map(norm) : x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, norm((x as Record<string, unknown>)[k])])) : x);
  return JSON.stringify(norm(v));
}

// Whether a change touches what the maker set: when it runs, what it asks
// at setup, its limits. Those stop at the steps to ask.
export function changesTheirs(before: AgentDefinition | null, after: AgentDefinition): boolean {
  if (!before) return false;
  const when = (d: AgentDefinition) => canonical(d.triggers);
  const asks = (d: AgentDefinition) => JSON.stringify(d.settings.map((s) => [s.key, s.type, s.given ?? ""]).sort());
  const limits = (d: AgentDefinition) => JSON.stringify(d.rules.map((r) => [r.key, r.type, r.value]).sort());
  return when(before) !== when(after) || asks(before) !== asks(after) || limits(before) !== limits(after);
}

// What changed, in words, saying first anything that touches what the
// maker set and asking about it.
export function changeNote(before: AgentDefinition | null, after: AgentDefinition): string {
  const was = plainLines(before);
  const now = plainLines(after);
  const parts: string[] = [];
  if (before) {
    const t = (d: AgentDefinition) =>
      d.triggers
        .map((x) => (x.kind === "schedule" ? x.description : x.kind === "check" ? `when ${x.when}` : "when you message it"))
        .join(", ");
    if (canonical(before.triggers) !== canonical(after.triggers)) parts.push(`It now runs ${plain(t(after)).toLowerCase()}, not ${plain(t(before)).toLowerCase()}.`);
    for (const r of after.rules) {
      const old = before.rules.find((x) => x.key === r.key);
      if (!old) parts.push(`It has a new limit, "${plain(r.label)}", set to ${r.value}.`);
      else if (old.value !== r.value) parts.push(`"${plain(r.label)}" is now ${r.value}, not ${old.value}.`);
    }
    for (const r of before.rules) if (!after.rules.some((x) => x.key === r.key)) parts.push(`It no longer has the limit "${plain(r.label)}".`);
    for (const s of after.settings) if (!before.settings.some((x) => x.key === s.key)) parts.push(`It now asks you for "${plain(s.label)}" when you connect it.`);
    for (const s of before.settings) if (!after.settings.some((x) => x.key === s.key)) parts.push(`It no longer asks for "${plain(s.label)}".`);
  }
  const added = now.filter((l) => !was.some((w) => w.text === l.text));
  const gone = was.filter((w) => !now.some((l) => l.text === w.text));
  const theirs = before ? changesTheirs(before, after) : false;
  const steps = !added.length && !gone.length ? "The steps read the same as before." : `${added.length ? `New or changed: ${added.map((l) => `"${l.text}"`).join(", ")}.` : ""}${gone.length ? ` Gone: ${gone.map((l) => `"${l.text}"`).join(", ")}.` : ""}`.trim();
  return [`I changed the steps. ${steps}`, ...parts, theirs ? "That changes something you set: if it's right, press Looks right; if not, say what it should be." : ""].filter(Boolean).join(" ");
}

type Refused = { refused: { status: number; error: string } };
type Ready = { user: User; agent: Agent; ctx: BuildContext; conversationId: string };

// Who is building, on whose key, and room in the day's limits.
async function ready(user: User, agent: Agent): Promise<Ready | Refused> {
  const conversationId = agent.sourceConversationId;
  if (!conversationId) return { refused: { status: 400, error: "This agent wasn't made in a chat." } };
  const ctx = buildContext(user, conversationId);
  if (!ctx) return { refused: { status: 503, error: NOT_AVAILABLE } };
  const no = await refusal(user.id, { ownKey: ctx.ownKey });
  if (no) return { refused: { status: 429, error: no.error } };
  return { user, agent, ctx, conversationId };
}

// How the build in the chat settles: a test card as the first test starts
// (a test again, after a repair, stays on it), and Connect once it passes.
// A failure heals itself (build.ts), its lines on the card it happens on;
// a question the fixer has for the maker is asked in the chat, with its
// answers to tap.
export function settleIn(conversationId: string, agentId: string): Settle {
  return {
    onTest: async () => {
      if ((await cardsIn(conversationId)).at(-1)?.card?.stage !== "try") await addCard(conversationId, { stage: "try", agentId }, "Trying it on a sample.");
    },
    onTested: async (result) => {
      if (result.status === "passed") await addCard(conversationId, { stage: "connect", agentId }, "Connecting it to what it needs.");
    },
    onAsk: async (question) => (await say(conversationId, question.text)).id,
  };
}

const BUSY = "It's busy with the last thing you asked. Give it a moment.";

export type Moved = { agent: AgentSummaryDTO } | Refused;

// Make it: the agent's steps are worked out, and wait for the maker to
// look at them.
export async function makeIt(user: User, conversationId: string, feedback: string | null = null): Promise<Moved> {
  const sketch = await loadSketch(conversationId);
  if (!describedEnough(sketch)) return { refused: { status: 400, error: "Tell me a little more about the job first." } };
  const ctx = buildContext(user, conversationId);
  if (!ctx) return { refused: { status: 503, error: NOT_AVAILABLE } };
  const no = await refusal(user.id, { ownKey: ctx.ownKey });
  if (no) return { refused: { status: 429, error: no.error } };
  const history = await db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt));
  // A source it can't read with what it was given (a form's public link,
  // a page behind a sign-in) is never planned as a step that pretends to
  // read it: the maker is told what it would take, or what works instead.
  const lastSaid = history.filter((m) => m.role === "user").at(-1)?.content ?? "";
  const rt = serverRuntime();
  const connected = new Set((await hasConnection(rt, user.id, "typeform")) ? ["typeform"] : []);
  const unreadable = unreadableIn([...Object.values(sketch!).filter((v): v is string => typeof v === "string"), lastSaid, feedback ?? ""].join("\n"), connected);
  if (unreadable) return { refused: { status: 400, error: sourceAsk(unreadable.problem, `/app/chat?c=${conversationId}`) } };
  // A Typeform form it will read, with Typeform connected: its questions
  // as the form words them, for the plan to read the answers by.
  const notes = connected.has("typeform") ? await formNotes(rt, user.id, [...history.filter((m) => m.role === "user").map((m) => m.content), ...Object.values(sketch!).filter((v): v is string => typeof v === "string")].join("\n")) : [];
  const existing = await agentForConversation(conversationId);
  const { agent, draft } = existing ? { agent: existing, draft: await editableDraft(existing.id) } : await createAgent({ ownerUserId: user.id, conversationId, name: await nameOfNew(user.id, sketch!.name ?? "Unnamed agent") });
  if (jobFor(draft.id)) return { refused: { status: 409, error: BUSY } };
  if ((await cardsIn(conversationId)).at(-1)?.card?.stage !== "steps") await addCard(conversationId, { stage: "steps", agentId: agent.id }, "Working out the steps.");
  startPlan(draft, { interview: sketch!, history, feedback, notes }, ctx, "plan", {
    stop: true,
    planned: async (_before, after) => {
      if (after) await setStepsWords(conversationId, after);
    },
    settle: settleIn(conversationId, agent.id),
  });
  return { agent: summaryOf(agent, { ...draft, buildState: "planning", buildNote: null }) };
}

// What the plan should know of a Typeform form the maker named: its
// questions, by title. Nothing when it can't be read just now: the plan
// goes on without.
async function formNotes(rt: Runtime, ownerUserId: string, said: string): Promise<string[]> {
  const link = typeformLinkIn(said);
  const id = link ? formIdOf(link) : null;
  const secret = id ? await secretOf(rt, ownerUserId, "typeform") : null;
  if (!id || !secret) return [];
  try {
    const form = await formQuestions(rt.services.fetch, secret.token, id);
    return [`The maker's Typeform form ${link} has these questions, and typeform.read gives each response's answers under exactly these titles: ${form.questions.map((q) => `"${q.title}"`).join(", ")}. A step reads the form with typeform.read({ form: settings.<its link setting> }), the link being a url setting the maker gave.`];
  } catch {
    return [];
  }
}

// A name none of the maker's other agents has: "Price watcher 2" beside
// "Price watcher".
export async function nameOfNew(ownerUserId: string, name: string): Promise<string> {
  const taken = new Set((await agentsOf(ownerUserId)).map((a) => a.name.trim().toLowerCase()));
  if (!taken.has(name.trim().toLowerCase())) return name;
  for (let i = 2; ; i++) if (!taken.has(`${name} ${i}`.toLowerCase())) return `${name} ${i}`;
}

// The latest Steps card says its steps in words, for the history.
async function setStepsWords(conversationId: string, d: AgentDefinition): Promise<void> {
  const last = (await cardsIn(conversationId)).filter((m) => m.card?.stage === "steps").at(-1);
  if (last && !last.card?.snapshot) await db.update(messages).set({ content: `The steps:\n${listed(plainLines(d))}` }).where(eq(messages.id, last.id));
}

// Looks right: each step is written and checked, then it is tried.
export async function looksRight(user: User, agent: Agent): Promise<Moved> {
  const r = await ready(user, agent);
  if ("refused" in r) return r;
  const draft = await editableDraft(agent.id);
  if (!draft.definition) return { refused: { status: 400, error: "There are no steps to build yet." } };
  if (draft.buildState !== "idle" && draft.buildState !== "failed") return { refused: { status: 409, error: BUSY } };
  if (jobFor(draft.id)) return { refused: { status: 409, error: BUSY } };
  await addCard(r.conversationId, { stage: "build", agentId: agent.id }, "Building and checking each step.");
  startBuild(draft, r.ctx, settleIn(r.conversationId, agent.id));
  return { agent: summaryOf(agent, { ...draft, buildState: "writing", buildNote: null }) };
}

// Change something: the steps change from what the maker says and wait
// for them to look again. Said already when it came in the chat.
export async function changeSteps(user: User, agent: Agent, message: string, o: { said?: boolean } = {}): Promise<Moved> {
  const r = await ready(user, agent);
  if ("refused" in r) return r;
  const draft = await editableDraft(agent.id);
  if (!draft.definition) return makeIt(user, r.conversationId);
  if (jobFor(draft.id) || draft.buildState === "planning" || draft.buildState === "writing" || draft.buildState === "fixing") return { refused: { status: 409, error: BUSY } };
  const at = (await cardsIn(r.conversationId)).at(-1)?.card?.stage;
  if (!o.said) await heard(r.conversationId, message);
  if (at !== "steps") await addCard(r.conversationId, { stage: "steps", agentId: agent.id }, "Changing the steps.");
  startPlan(draft, await planInputFor(r.conversationId, draft.definition, message), r.ctx, "fix", {
    stop: true,
    planned: async (before, after, why) => {
      if (!after) await say(r.conversationId, `I couldn't change the steps: ${lowerFirst(why ?? "it didn't come together")} They are as they were.`);
      else {
        await setStepsWords(r.conversationId, after);
        await say(r.conversationId, changeNote(before, after));
      }
    },
  });
  return { agent: summaryOf(agent, { ...draft, buildState: "fixing", buildNote: null }) };
}

// Fix it, from a failed test or a step that didn't pass its check: a step
// on hold is written again; anything else changes the steps from what the
// maker says, and builds and tries them again on its own unless the change
// touches what they set, which waits for them to look.
export async function fixIt(user: User, agent: Agent, change: { message: string } | { step: string }): Promise<Moved> {
  const r = await ready(user, agent);
  if ("refused" in r) return r;
  const draft = await editableDraft(agent.id);
  if (!draft.definition) return { refused: { status: 400, error: "There are no steps to fix yet." } };
  if (jobFor(draft.id) || draft.buildState === "planning" || draft.buildState === "writing" || draft.buildState === "fixing") return { refused: { status: 409, error: BUSY } };
  const settle = settleIn(r.conversationId, agent.id);
  if ("step" in change) {
    if (!draft.definition.steps.some((s) => s.id === change.step && s.kind === "code")) return { refused: { status: 400, error: "There's no such step to write again." } };
    await addCard(r.conversationId, { stage: "build", agentId: agent.id }, "Writing that step again.");
    startRewrite(draft, change.step, r.ctx, undefined, settle);
    return { agent: summaryOf(agent, { ...draft, buildState: "writing", buildNote: null }) };
  }
  await heard(r.conversationId, change.message);
  await addCard(r.conversationId, { stage: "steps", agentId: agent.id }, "Changing the steps.");
  startPlan(draft, await planInputFor(r.conversationId, draft.definition, change.message), r.ctx, "fix", {
    stop: (before, after) => changesTheirs(before, after),
    planned: async (before, after, why) => {
      if (!after) return void (await say(r.conversationId, `I couldn't fix it that way: ${lowerFirst(why ?? "it didn't come together")} The steps are as they were.`));
      await setStepsWords(r.conversationId, after);
      await say(r.conversationId, changeNote(before, after));
      if (!changesTheirs(before, after)) await addCard(r.conversationId, { stage: "build", agentId: agent.id }, "Building the changed steps.");
    },
    settle,
  });
  return { agent: summaryOf(agent, { ...draft, buildState: "fixing", buildNote: null }) };
}

const lowerFirst = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);

// The maker's answer to the fixer's question (tapped, or typed in the chat,
// where it is their message already): the build goes on with it.
export async function answer(user: User, agent: Agent, text: string, o: { said?: boolean } = {}): Promise<Moved> {
  const r = await ready(user, agent);
  if ("refused" in r) return r;
  const draft = await editableDraft(agent.id);
  if (!draft.heal?.question) return { refused: { status: 409, error: "There's no question waiting for you." } };
  if (jobFor(draft.id)) return { refused: { status: 409, error: BUSY } };
  if (!o.said) await heard(r.conversationId, text);
  const settle = settleIn(r.conversationId, agent.id);
  // No steps yet: once they come together, they wait for the maker to look.
  const after = draft.definition ? undefined : { stop: true, planned: async (_b: AgentDefinition | null, d: AgentDefinition | null) => void (d && (await setStepsWords(r.conversationId, d))), settle };
  answerQuestion(draft, text, r.ctx, settle, after);
  return { agent: summaryOf(agent, { ...draft, buildState: "fixing", buildNote: null }) };
}

// Try a simpler version, when it gave up: the steps are changed to leave out
// what it couldn't do, and wait for the maker to look.
export async function simpler(user: User, agent: Agent): Promise<Moved> {
  const r = await ready(user, agent);
  if ("refused" in r) return r;
  const draft = await editableDraft(agent.id);
  const gaveUp = draft.heal?.gaveUp;
  if (!gaveUp) return { refused: { status: 409, error: "It hasn't given up on anything." } };
  await say(r.conversationId, "Making a simpler version of it.");
  const change = `Make a simpler version that leaves out what it couldn't do (${gaveUp}), keeping the rest of the job as I described it.`;
  if (!draft.definition) return makeIt(user, r.conversationId, change);
  return changeSteps(user, agent, change, { said: true });
}

// The stage a conversation's journey is at, by its cards.
export async function stageIn(conversationId: string): Promise<Stage | null> {
  return (await cardsIn(conversationId)).at(-1)?.card?.stage ?? null;
}

export async function conversationOf(user: User, id: string) {
  return (await db.query.conversations.findFirst({ where: and(eq(conversations.id, id), eq(conversations.userId, user.id)) })) ?? null;
}
