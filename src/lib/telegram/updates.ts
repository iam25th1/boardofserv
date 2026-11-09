import "server-only";
import { and, eq, gt, isNull } from "drizzle-orm";
import { accessOf } from "../access";
import { agentApprovals, agentJobs, agentMessages, agentVersions, telegramPending, telegramUpdates, users } from "../db/schema";
import { answer, AnswerRefused } from "../agents/runtime/approvals";
import type { Runtime } from "../agents/runtime/context";
import { installationsOf, loadInstallation } from "../agents/runtime/installations";
import { MessageRefused, sendToAgent } from "../agents/runtime/messages";
import { keep, ownerOfChat } from "../connections/vault";
import { clip, tg, TelegramError, type TgMessage, type TgUpdate } from "./api";
import { settledText } from "./deliver";
import { redeemLinkCode } from "./link";

// What the bot does with an update from Telegram (the webhook has already
// checked its secret):
//
// - /start CODE from a private chat links that chat to the owner the code
//   was made for. A chat links to one owner at a time.
// - Any other text from a linked chat is a message for one of its owner's
//   agents that take messages: straight to it when there is one, or, when
//   there are several, a short menu of them to pick from first.
// - A button under a question answers it, exactly as the app's buttons do,
//   whichever comes first. The question's message then says the answer.
//
// Each update is handled once, even when Telegram sends it again. Group
// chats and anything but text are left alone.

const MENU_MINUTES = 10;
const MAX_MENU = 8;
const MAX_TEXT = 2000;

// The bot's replies are best effort: what the update asked for is done
// (and kept) whether or not the reply gets through.
async function reply(rt: Runtime, chatId: number, text: string, extra: Record<string, unknown> = {}): Promise<void> {
  await tg(rt.services, "sendMessage", { chat_id: chatId, text: clip(text), ...extra }).catch((err: unknown) => {
    if (!(err instanceof TelegramError)) throw err;
    rt.log(`telegram: a reply wasn't delivered: ${err.message}`);
  });
}

const LINK_HOW = "To link this chat, open boardofserv, go to Connections and press Link Telegram. Then send me the code it shows.";

export async function handleUpdate(rt: Runtime, update: TgUpdate): Promise<void> {
  if (!Number.isSafeInteger(update.update_id)) return;
  const fresh = await rt.db.insert(telegramUpdates).values({ updateId: update.update_id, receivedAt: rt.now() }).onConflictDoNothing().returning();
  if (!fresh.length) return;
  try {
    if (update.callback_query) await onButton(rt, update.callback_query);
    else if (update.message) await onMessage(rt, update.message);
  } catch (err) {
    // Not handled after all: Telegram may send it again.
    await rt.db.delete(telegramUpdates).where(eq(telegramUpdates.updateId, update.update_id));
    throw err;
  }
}

async function onMessage(rt: Runtime, m: TgMessage): Promise<void> {
  if (m.chat.type !== "private" || !m.from || m.from.is_bot) return;
  const chatId = m.chat.id;
  const text = (m.text ?? "").trim();
  const owner = await ownerOfChat(rt, chatId);
  const start = /^\/start(?:@\w+)?(?:\s+(\S+))?$/.exec(text);
  if (start) {
    const code = start[1];
    if (!code) return void (await reply(rt, chatId, owner ? "This chat is linked to boardofserv. Send me a message for your agents any time." : LINK_HOW));
    const who = await redeemLinkCode(rt, code);
    if (!who) return void (await reply(rt, chatId, "That code didn't work: it may be mistyped, used already, or more than 10 minutes old. Get a new one on boardofserv, under Connections."));
    if (owner && owner !== who) return void (await reply(rt, chatId, "This chat is linked to another boardofserv account. Disconnect Telegram there first, then try again."));
    const label = m.from.username ? `@${m.from.username}` : (m.from.first_name ?? "your chat");
    await keep(rt, who, "telegram", label, { chatId, userId: m.from.id });
    await reply(rt, chatId, "Linked. Your agents on boardofserv message you here, and ask you things with buttons. Message me any time and I'll pass it to the agent you pick.");
    return;
  }
  if (!owner) return void (await reply(rt, chatId, `This chat isn't linked to boardofserv. ${LINK_HOW}`));
  if (!text) return void (await reply(rt, chatId, "I only pass on text messages."));
  const [user] = await rt.db.select().from(users).where(eq(users.id, owner));
  if (!user || accessOf(user) !== "approved") return void (await reply(rt, chatId, "Your boardofserv account isn't let in yet, so your agents can't take messages."));
  const takers = (await installationsOf(rt, owner)).filter((l) => l.installation.status === "active" && l.installation.live && l.definition.triggers.some((t) => t.kind === "message")).slice(0, MAX_MENU);
  if (!takers.length) return void (await reply(rt, chatId, "None of your running agents take messages."));
  const body = text.slice(0, MAX_TEXT);
  if (takers.length === 1) return void (await pass(rt, chatId, takers[0]!.installation.id, owner, body));
  const [menu] = await rt.db
    .insert(telegramPending)
    .values({ ownerUserId: owner, text: body, installationIds: takers.map((l) => l.installation.id), createdAt: rt.now() })
    .returning({ id: telegramPending.id });
  await reply(rt, chatId, "Which agent is this for?", {
    reply_markup: { inline_keyboard: takers.map((l, i) => [{ text: l.definition.name.slice(0, 60), callback_data: `m:${menu!.id}:${i}` }]) },
  });
}

// The message goes to one installation, as the app's message box would
// send it. Returns what to tell the owner.
async function deliverTo(rt: Runtime, installationId: string, owner: string, text: string): Promise<string> {
  const l = await loadInstallation(rt, installationId);
  if (!l || l.installation.ownerUserId !== owner) return "That agent isn't there any more.";
  try {
    const message = await sendToAgent(rt, l.installation, l.definition, text);
    await rt.db.update(agentMessages).set({ tgState: "telegram" }).where(eq(agentMessages.id, message.id));
    return `Passed to ${l.definition.name}. It starts on it now.`;
  } catch (err) {
    if (err instanceof MessageRefused) return `${l.definition.name}: ${err.message}`;
    throw err;
  }
}

async function pass(rt: Runtime, chatId: number, installationId: string, owner: string, text: string): Promise<void> {
  await reply(rt, chatId, await deliverTo(rt, installationId, owner, text));
}

type Callback = NonNullable<TgUpdate["callback_query"]>;

async function onButton(rt: Runtime, cb: Callback): Promise<void> {
  const say = (text: string) => tg(rt.services, "answerCallbackQuery", { callback_query_id: cb.id, text: text.slice(0, 190) }).catch(() => undefined);
  const chatId = cb.message?.chat.id;
  const owner = chatId !== undefined && cb.message?.chat.type === "private" ? await ownerOfChat(rt, chatId) : null;
  if (!owner || chatId === undefined) return void (await say("This chat isn't linked to boardofserv."));
  const parsed = /^([am]):([0-9a-f-]{36}):(\d{1,2})$/.exec(cb.data ?? "");
  if (!parsed) return void (await say("That button doesn't do anything now."));
  const [, kind, id, n] = parsed as unknown as [string, "a" | "m", string, string];
  const index = Number(n);

  if (kind === "m") {
    const [menu] = await rt.db
      .update(telegramPending)
      .set({ usedAt: rt.now() })
      .where(and(eq(telegramPending.id, id), eq(telegramPending.ownerUserId, owner), isNull(telegramPending.usedAt), gt(telegramPending.createdAt, new Date(rt.now().getTime() - MENU_MINUTES * 60_000))))
      .returning();
    if (!menu) return void (await say("That menu is used or too old. Send the message again."));
    const target = menu.installationIds[index];
    const said = target ? await deliverTo(rt, target, owner, menu.text) : "That agent isn't there any more.";
    await say(said);
    if (cb.message) await tg(rt.services, "editMessageText", { chat_id: chatId, message_id: cb.message.message_id, text: clip(`${menu.text}\n\n${said}`) }).catch(() => undefined);
    return;
  }

  // An answer to a question: only the owner's own, only while it waits.
  const [row] = await rt.db
    .select({ approval: agentApprovals, definition: agentVersions.definition })
    .from(agentApprovals)
    .innerJoin(agentJobs, eq(agentJobs.id, agentApprovals.jobId))
    .innerJoin(agentVersions, eq(agentVersions.id, agentJobs.versionId))
    .where(and(eq(agentApprovals.id, id), eq(agentApprovals.ownerUserId, owner)));
  if (!row) return void (await say("That question isn't yours, or isn't there any more."));
  const option = row.approval.options[index];
  if (!option) return void (await say("That answer isn't one of its answers."));
  let settled = row.approval;
  try {
    settled = await answer(rt, owner, id, option.label);
    await say(`Answered: ${option.label}`);
  } catch (err) {
    if (!(err instanceof AnswerRefused)) throw err;
    await say(err.message);
    const [now] = await rt.db.select().from(agentApprovals).where(eq(agentApprovals.id, id));
    if (now) settled = now;
  }
  // This message shows the answer now; the app shows it on its next look.
  if (cb.message && settled.status !== "pending") {
    await tg(rt.services, "editMessageText", { chat_id: chatId, message_id: cb.message.message_id, text: settledText(settled, row.definition) }).catch(() => undefined);
    await rt.db.update(agentApprovals).set({ tgState: "closed" }).where(eq(agentApprovals.id, id));
  }
}
