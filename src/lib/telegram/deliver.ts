import "server-only";
import { and, asc, eq, inArray, lt, ne, sql } from "drizzle-orm";
import { agentApprovals, agentInstallations, agentMessages, agentVersions, telegramLinkCodes, telegramPending, telegramUpdates, type AgentApproval } from "../db/schema";
import type { AgentDefinition } from "../agents/definition";
import type { ApprovalDTO } from "../types";
import { approvalDTO } from "../agents/runtime/approvals";
import { HELD_ALL } from "../agents/heldIds";
import { opinionsFor, ROUTE_WORDS } from "../reppo/opinion";
import type { Runtime } from "../agents/runtime/context";
import { secretOf, touch } from "../connections/vault";
import { clip, numberedParts, sendText, TelegramError, type InlineKeyboard } from "./api";

// What goes out to owners' Telegram chats, from the worker's cycle: the
// questions their jobs wait on (a button per answer), what their agents
// send them (telegram.send), and, once a question is answered, expired or
// stopped, an edit of its message to say so and take the buttons away.
//
// Everything goes to the chat the owner linked, found in the vault by the
// installation's owner: there is no other address, so an agent can never
// reach anyone else. Each row is its own outbox entry, so a send that
// fails is tried again on the next cycles (five times at most), and
// nothing waits on Telegram: a job goes on (or waits) whether or not
// Telegram answered. Past Telegram's rate limit (429), sending stops until
// the time it asks for has passed.

const MAX_ATTEMPTS = 5;
const holds = new Map<string, number>();

export const answerData = (approvalId: string, index: number) => `a:${approvalId}:${index}`;

type Opinion = NonNullable<ApprovalDTO["opinion"]>;
type Items = NonNullable<ApprovalDTO["items"]>;

// Reppo's second opinion in one line: its score, route and reason.
export function reppoLine(o: Opinion): string | null {
  if (o.state === "ready") return `Reppo: ${o.score === null ? "no score" : `${o.score} out of 100`}, ${o.route ? ROUTE_WORDS[o.route] : "no recommendation"}.${o.reason ? ` ${o.reason}` : ""}`;
  return null;
}

const cut = (t: string, max: number) => (t.length > max ? `${t.slice(0, max - 3).trimEnd()}..."` : `${t}"`);

// A held message on the question, with its links, each risky one flagged;
// shorter when the whole question would be too long for one message.
function itemLines(items: Items, room: number): string[] {
  const one = items.length === 1;
  const render = (textMax: number, shown: number) => [
    ...items.slice(0, shown).flatMap((m, i) => [
      `${one ? "" : `${i + 1}. `}"${cut(m.text, textMax)}`,
      ...(m.links.length ? [`${one ? "" : "   "}Links: ${m.links.map((l) => `${l.link}${l.risky ? " (Reppo calls this risky)" : ""}`).join(", ")}`] : []),
    ]),
    ...(shown < items.length ? [`And ${items.length - shown} more: see them all in the app.`] : []),
  ];
  for (const textMax of [400, 120, 60]) {
    const lines = render(textMax, items.length);
    if (lines.join("\n").length <= room) return lines;
  }
  for (let shown = items.length - 1; shown > 0; shown--) {
    const lines = render(60, shown);
    if (lines.join("\n").length <= room) return lines;
  }
  return render(60, 1);
}

// The question as its Telegram message: the agent, the question (with the
// messages it is about, when a run held some), why it asks (for a payment,
// what its trust band allows), what each answer does, and what happens with
// none. With Reppo: that its second opinion is coming (true), or, on the
// question about held messages, the opinion itself once it has come, and
// that the answer decides either way.
export function approvalText(a: Pick<AgentApproval, "question" | "options" | "noAnswer" | "stepId"> & { reason?: string | null; items?: Items | null }, d: AgentDefinition | null, opinion: boolean | Opinion | null = false): string {
  const step = d?.steps.find((s) => s.id === a.stepId)?.title;
  const head = [`${d?.name ?? "Your agent"}${step ? `, at "${step}"` : ""}, asks:`, "", a.question, ""];
  const tail: string[] = [];
  if (a.reason) tail.push(`Why it asks: ${a.reason}`, "");
  const said = typeof opinion === "object" && opinion ? reppoLine(opinion) : null;
  if (said) tail.push(said, "");
  for (const o of a.options) tail.push(`${o.label}: ${o.effect}`);
  tail.push(a.noAnswer);
  if (opinion === true) tail.push("", "Reppo is still checking it for a second opinion, which will follow here. Your answer decides either way.");
  if (said) tail.push("", "Your answer decides: Reppo never approves or blocks anything.");
  const items = a.items?.length ? [...itemLines(a.items, 3_900 - [...head, ...tail].join("\n").length), ""] : [];
  return clip([...head, ...items, ...tail].join("\n"));
}

// The same message once it is settled, without its buttons.
export function settledText(a: Pick<AgentApproval, "question" | "options" | "noAnswer" | "stepId" | "status" | "answer">, d: AgentDefinition | null): string {
  const step = d?.steps.find((s) => s.id === a.stepId)?.title;
  const head = `${d?.name ?? "Your agent"}${step ? `, at "${step}"` : ""}, asked:`;
  const end =
    a.status === "answered" ? `Answered: ${a.answer}.` : a.status === "expired" ? "No answer came in time." : a.status === "cancelled" ? "Its job was stopped, so it needs no answer now." : "";
  return clip([head, "", a.question, "", end].join("\n"));
}

export const keyboard = (a: Pick<AgentApproval, "id" | "options">): InlineKeyboard => a.options.map((o, i) => [{ text: o.label.slice(0, 60), callback_data: answerData(a.id, i) }]);

async function chatOf(rt: Runtime, ownerUserId: string): Promise<number | null> {
  return (await secretOf(rt, ownerUserId, "telegram"))?.chatId ?? null;
}

// A failed attempt: tried again later, or given up on. True when sending
// must stop for now (Telegram's rate limit).
function failed(rt: Runtime, err: unknown, what: string): boolean {
  if (err instanceof TelegramError && err.status === 429) {
    holds.set(rt.services.telegramToken ?? "", rt.now().getTime() + Math.min(Math.max(err.retryAfter ?? 5, 1), 300) * 1000);
    rt.log(`telegram: rate limited, waiting ${err.retryAfter ?? 5} s before sending more`);
    return true;
  }
  rt.log(`telegram: ${what} wasn't delivered: ${err instanceof Error ? err.message : "unknown error"}`);
  return false;
}

const definitionsOf = async (rt: Runtime, installationIds: string[]): Promise<Map<string, AgentDefinition | null>> => {
  if (!installationIds.length) return new Map();
  const rows = await rt.db
    .select({ id: agentInstallations.id, definition: agentVersions.definition })
    .from(agentInstallations)
    .innerJoin(agentVersions, eq(agentVersions.id, agentInstallations.versionId))
    .where(inArray(agentInstallations.id, [...new Set(installationIds)]));
  return new Map(rows.map((r) => [r.id, r.definition]));
};

// One cycle's sending. Returns how many messages went out or were edited.
export async function deliverTelegram(rt: Runtime, limit = 20): Promise<number> {
  const key = rt.services.telegramToken ?? "";
  if (!rt.services.telegramToken) {
    // Telegram isn't set up here: in-app only.
    await rt.db.update(agentApprovals).set({ tgState: "none" }).where(eq(agentApprovals.tgState, "pending"));
    await rt.db.update(agentMessages).set({ tgState: "none" }).where(eq(agentMessages.tgState, "pending"));
    return 0;
  }
  if ((holds.get(key) ?? 0) > rt.now().getTime()) return 0;
  let done = 0;

  // Questions to send: with a button per answer. One answered in the app
  // before it went out needs no message at all.
  const asks = await rt.db.select().from(agentApprovals).where(eq(agentApprovals.tgState, "pending")).limit(limit);
  const toClose = await rt.db
    .select()
    .from(agentApprovals)
    .where(and(eq(agentApprovals.tgState, "sent"), ne(agentApprovals.status, "pending")))
    .limit(limit);
  const outgoing = await rt.db.select().from(agentMessages).where(eq(agentMessages.tgState, "pending")).orderBy(asc(agentMessages.createdAt)).limit(limit);
  // Reppo's second opinions on them.
  const opinions = await opinionsFor(
    rt,
    asks.map((a) => a.id),
  );
  const defs = await definitionsOf(rt, [...asks, ...toClose, ...outgoing].map((r) => r.installationId));
  // A question's text: on the one about held messages, Reppo's opinion
  // itself once it has come.
  const textOf = (a: AgentApproval) => {
    const d = defs.get(a.installationId) ?? null;
    const shown = approvalDTO(a, d, opinions.get(a.id) ?? null);
    return approvalText({ ...a, items: shown.items }, d, a.stepId === HELD_ALL ? (shown.opinion ?? null) : opinions.has(a.id));
  };
  const owners = outgoing.length
    ? await rt.db
        .select({ id: agentInstallations.id, owner: agentInstallations.ownerUserId })
        .from(agentInstallations)
        .where(inArray(agentInstallations.id, [...new Set(outgoing.map((m) => m.installationId))]))
    : [];
  const ownerOf = new Map(owners.map((o) => [o.id, o.owner]));

  for (const a of asks) {
    if (a.status !== "pending") {
      await rt.db.update(agentApprovals).set({ tgState: "none" }).where(eq(agentApprovals.id, a.id));
      continue;
    }
    const chat = await chatOf(rt, a.ownerUserId);
    if (chat === null) {
      await rt.db.update(agentApprovals).set({ tgState: "none" }).where(eq(agentApprovals.id, a.id));
      continue;
    }
    try {
      const sent = await sendText<{ message_id: number }>(rt.services, "sendMessage", { chat_id: chat, text: textOf(a), reply_markup: { inline_keyboard: keyboard(a) } });
      // Answered in the app while it was on its way: settle it next cycle.
      await rt.db.update(agentApprovals).set({ tgState: "sent", tgMessageId: sent.message_id }).where(eq(agentApprovals.id, a.id));
      await touch(rt, a.ownerUserId, "telegram");
      done += 1;
    } catch (err) {
      const stop = failed(rt, err, "a question");
      await rt.db
        .update(agentApprovals)
        .set({ tgAttempts: sql`${agentApprovals.tgAttempts} + 1`, tgState: a.tgAttempts + 1 >= MAX_ATTEMPTS ? "failed" : "pending" })
        .where(eq(agentApprovals.id, a.id));
      if (stop) return done;
    }
  }

  // Questions settled (here, in the app, or by the clock): the message says
  // how, and its buttons go.
  for (const a of toClose) {
    const chat = await chatOf(rt, a.ownerUserId);
    if (chat === null || a.tgMessageId === null) {
      await rt.db.update(agentApprovals).set({ tgState: "closed" }).where(eq(agentApprovals.id, a.id));
      continue;
    }
    try {
      await sendText(rt.services, "editMessageText", { chat_id: chat, message_id: a.tgMessageId, text: settledText(a, defs.get(a.installationId) ?? null) });
      await rt.db.update(agentApprovals).set({ tgState: "closed" }).where(eq(agentApprovals.id, a.id));
      done += 1;
    } catch (err) {
      // Telegram says the message already reads that way, or is gone.
      if (err instanceof TelegramError && err.status === 400) {
        await rt.db.update(agentApprovals).set({ tgState: "closed" }).where(eq(agentApprovals.id, a.id));
        continue;
      }
      const stop = failed(rt, err, "an answered question's message");
      await rt.db
        .update(agentApprovals)
        .set({ tgAttempts: sql`${agentApprovals.tgAttempts} + 1`, tgState: a.tgAttempts + 1 >= MAX_ATTEMPTS ? "closed" : "sent" })
        .where(eq(agentApprovals.id, a.id));
      if (stop) return done;
    }
  }

  // What agents send their owners.
  for (const m of outgoing) {
    const owner = ownerOf.get(m.installationId);
    const chat = owner ? await chatOf(rt, owner) : null;
    if (chat === null) {
      await rt.db.update(agentMessages).set({ tgState: "none" }).where(eq(agentMessages.id, m.id));
      continue;
    }
    try {
      // HTML, with the agent's own marks (*bold*, `code`) made into tags
      // and everything else escaped: never raw markdown. One too long for
      // a Telegram message goes in numbered parts, in order, each kept as
      // delivered once it is: after a failure part way, the next try sends
      // only the parts still missing.
      const parts = numberedParts(`${defs.get(m.installationId)?.name ?? "Your agent"}: ${m.text}`);
      for (let i = m.tgParts; i < parts.length; i++) {
        await sendText(rt.services, "sendMessage", { chat_id: chat, text: parts[i]! });
        await rt.db.update(agentMessages).set({ tgParts: i + 1 }).where(eq(agentMessages.id, m.id));
      }
      await rt.db.update(agentMessages).set({ tgState: "sent" }).where(eq(agentMessages.id, m.id));
      await touch(rt, owner!, "telegram");
      done += 1;
    } catch (err) {
      const stop = failed(rt, err, "a message");
      await rt.db
        .update(agentMessages)
        .set({ tgAttempts: sql`${agentMessages.tgAttempts} + 1`, tgState: m.tgAttempts + 1 >= MAX_ATTEMPTS ? "failed" : "pending" })
        .where(eq(agentMessages.id, m.id));
      if (stop) return done;
    }
  }
  return done;
}

// Forgets what is no longer needed: handled updates after three days,
// unused menus and codes after a day.
export async function tidyTelegram(rt: Runtime): Promise<void> {
  const now = rt.now().getTime();
  await rt.db.delete(telegramUpdates).where(lt(telegramUpdates.receivedAt, new Date(now - 3 * 86_400_000)));
  await rt.db.delete(telegramPending).where(lt(telegramPending.createdAt, new Date(now - 86_400_000)));
  await rt.db.delete(telegramLinkCodes).where(lt(telegramLinkCodes.expiresAt, new Date(now - 86_400_000)));
}

// For tests: forget any rate-limit wait.
export function resetTelegramHolds(): void {
  holds.clear();
}
