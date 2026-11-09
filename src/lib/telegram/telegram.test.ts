// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { eq, inArray } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { checkDefinition, type AgentDefinition } from "@/lib/agents/definition";
import { addUser, testDb } from "@/test/helperDb";
import { installed, linkConnections, publishedAgent, testRuntime, TEST_CHAT_ID, type TestRuntime } from "@/test/runtimeFixtures";
import { answer, approvalsOf, expireDue } from "../agents/runtime/approvals";
import { claimJob, enqueue, runJob } from "../agents/runtime/jobs";
import { ownerOfChat } from "../connections/vault";
import type { TgUpdate } from "./api";
import { deliverTelegram, resetTelegramHolds } from "./deliver";
import { codeHash, newLinkCode, storeWebhookSecret, redeemLinkCode, webhookSecretOk } from "./link";
import { handleUpdate } from "./updates";

// Telegram: linking a chat with a one-time code, questions with buttons
// that race the app's, messages that go only to the owner's own chat, and
// owners messaging their agents.

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let rt: TestRuntime;
let owner: schema.User;
let other: schema.User;
let updateId = 1;

beforeAll(async () => {
  ({ client, db } = await testDb());
  owner = await addUser(db, "tg.owner");
  other = await addUser(db, "tg.other");
  await db.update(schema.users).set({ access: "approved" }).where(inArray(schema.users.id, [owner.id, other.id]));
  rt = testRuntime(db);
  rt.net.on("https://api.telegram.org/bot123456:test-bot-token/getMe", () => Response.json({ ok: true, result: { id: 1, is_bot: true, username: "testbosbot" } }));
});
afterAll(async () => client.close());
beforeEach(async () => {
  await db.update(schema.agentApprovals).set({ status: "cancelled", tgState: "closed" }).where(eq(schema.agentApprovals.status, "pending"));
  await db.update(schema.agentJobs).set({ status: "cancelled" }).where(inArray(schema.agentJobs.status, ["queued", "running", "waiting_for_owner"]));
  await db.update(schema.agentInstallations).set({ status: "stopped" });
  await db.update(schema.agentMessages).set({ tgState: "sent" }).where(eq(schema.agentMessages.tgState, "pending"));
  rt.net.calls.length = 0;
  resetTelegramHolds();
});

const from = (id: number) => ({ id, is_bot: false, first_name: "Sam", username: `user${id}` });
const text = (chat: number, t: string): TgUpdate => ({ update_id: updateId++, message: { message_id: 1, from: from(chat), chat: { id: chat, type: "private" }, text: t } });
const press = (chat: number, data: string, messageId = 500): TgUpdate => ({
  update_id: updateId++,
  callback_query: { id: `cb${updateId}`, from: from(chat), message: { message_id: messageId, chat: { id: chat, type: "private" } }, data },
});
const replies = (chat: number) => rt.net.telegram("sendMessage").filter((m) => m.chat_id === chat).map((m) => String(m.text));

async function runOnce() {
  const job = await claimJob(rt, "w");
  if (job) await runJob(rt, job, "w");
  return job;
}

describe("linking a chat", () => {
  it("links the chat that sends /start CODE, once, within ten minutes", async () => {
    const link = await newLinkCode(rt, owner.id);
    expect(link.link).toBe(`https://t.me/testbosbot?start=${link.code}`);
    expect(link.code).toMatch(/^[A-Z2-9]{10}$/);
    // Only its hash is kept.
    const rows = await db.select().from(schema.telegramLinkCodes);
    expect(JSON.stringify(rows)).not.toContain(link.code);
    expect(rows.some((r) => r.codeHash === codeHash(link.code))).toBe(true);

    await handleUpdate(rt, text(7001, `/start ${link.code}`));
    expect(await ownerOfChat(rt, 7001)).toBe(owner.id);
    expect(replies(7001).at(-1)).toMatch(/^Linked\./);
    const [c] = await db.select().from(schema.connections).where(eq(schema.connections.ownerUserId, owner.id));
    expect(c!.label).toBe("@user7001");

    // Used up: the same code from another chat does nothing.
    await handleUpdate(rt, text(7002, `/start ${link.code}`));
    expect(await ownerOfChat(rt, 7002)).toBeNull();
    expect(replies(7002).at(-1)).toMatch(/didn't work/);
  });

  it("refuses a code after ten minutes, and a chat linked to someone else", async () => {
    const late = await newLinkCode(rt, other.id);
    rt.clock.move(10 * 60_000 + 1);
    expect(await redeemLinkCode(rt, late.code)).toBeNull();
    const fresh = await newLinkCode(rt, other.id);
    await handleUpdate(rt, text(7001, `/start ${fresh.code}`));
    expect(await ownerOfChat(rt, 7001)).toBe(owner.id);
    expect(replies(7001).at(-1)).toMatch(/linked to another boardofserv account/);
  });

  it("caps the codes waiting at once", async () => {
    const u = await addUser(db, "tg.codes");
    for (let i = 0; i < 5; i++) await newLinkCode(rt, u.id);
    await expect(newLinkCode(rt, u.id)).rejects.toThrow(/5 codes waiting/);
  });

  it("handles an update Telegram sends twice only once", async () => {
    const u = text(7999, "/start");
    await handleUpdate(rt, u);
    await handleUpdate(rt, u);
    expect(replies(7999)).toHaveLength(1);
  });
});

describe("the webhook's secret", () => {
  it("takes only the secret set last, and the one before it for a few minutes", async () => {
    expect(await webhookSecretOk(rt, "anything")).toBe(false);
    await storeWebhookSecret(rt, "first-secret_ABC");
    expect(await webhookSecretOk(rt, "first-secret_ABC")).toBe(true);
    expect(await webhookSecretOk(rt, "first-secret_ABD")).toBe(false);
    expect(await webhookSecretOk(rt, null)).toBe(false);
    await storeWebhookSecret(rt, "second-secret");
    expect(await webhookSecretOk(rt, "second-secret")).toBe(true);
    expect(await webhookSecretOk(rt, "first-secret_ABC")).toBe(true);
    rt.clock.move(11 * 60_000);
    expect(await webhookSecretOk(rt, "first-secret_ABC")).toBe(false);
    const [row] = await db.select().from(schema.telegramWebhook);
    expect(JSON.stringify(row)).not.toContain("second-secret");
  });
});

// An agent that tells its owner something, and takes their messages.
const NOTIFY = `async function run(input, tools) {
  await tools.telegram.send({ text: "Heard: " + (input.trigger && input.trigger.text) });
  return {};
}`;
function notifier(name: string): AgentDefinition {
  const c = checkDefinition({
    format: 1,
    name,
    job: { does: "Tells its owner what it heard.", done: "The owner is told." },
    triggers: [{ kind: "message", from: "telegram", description: "When you message it" }],
    settings: [],
    rules: [],
    memory: [],
    steps: [{ id: "tell", kind: "code", title: "Tell the owner", description: "Send the owner what it heard.", inputs: ["trigger"], outputs: [], tools: ["telegram.send"], next: null }],
    actions: [{ id: "tell_owner", tool: "telegram.send", description: "Tell the owner" }],
    limits: { maxSteps: 5, maxRunSeconds: 30, maxSpendUsd: 0.1 },
  });
  if (!c.ok) throw new Error(c.errors.join("; "));
  return c.definition;
}
const notifierAgent = (maker: schema.User, name: string) => publishedAgent(db, maker, { definition: notifier(name), code: { tell: { spec: "", status: "approved", source: NOTIFY, rounds: 1, note: null, updatedAt: "" } } });

describe("what agents send", () => {
  it("goes to the owner's own linked chat and nowhere else", async () => {
    const u = await addUser(db, "tg.sender");
    await linkConnections(rt, u, 8100);
    const v = await addUser(db, "tg.bystander");
    await linkConnections(rt, v, 8200);
    const inst = await installed(rt, u, await notifierAgent(u, "Teller"));
    await enqueue(rt, inst, { kind: "message", text: "hello there" });
    await runOnce();
    await deliverTelegram(rt);
    const sent = rt.net.telegram("sendMessage");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ chat_id: 8100, text: "Teller: Heard: hello there" });
    expect(sent.some((m) => m.chat_id === 8200)).toBe(false);
    // In the app's message box too.
    const [m] = await db.select().from(schema.agentMessages).where(eq(schema.agentMessages.installationId, inst.id));
    expect(m).toMatchObject({ from: "agent", tgState: "sent" });
  });

  it("stays in the app when the owner has no Telegram linked", async () => {
    const u = await addUser(db, "tg.unlinked");
    const inst = await installed(rt, u, await notifierAgent(u, "Quiet"));
    // Unlinked since (without the pause a disconnect brings, to see the send).
    await db.delete(schema.connections).where(eq(schema.connections.ownerUserId, u.id));
    await enqueue(rt, inst, { kind: "message", text: "hi" });
    await runOnce();
    await deliverTelegram(rt);
    expect(rt.net.telegram("sendMessage")).toHaveLength(0);
    const [m] = await db.select().from(schema.agentMessages).where(eq(schema.agentMessages.installationId, inst.id));
    expect(m!.tgState).toBe("none");
  });

  it("waits out Telegram's rate limit, then tries again", async () => {
    const u = await addUser(db, "tg.limited");
    await linkConnections(rt, u, 8300);
    const inst = await installed(rt, u, await notifierAgent(u, "Busy"));
    await enqueue(rt, inst, { kind: "message", text: "one" });
    await runOnce();
    let refuse = true;
    rt.net.on(/sendMessage$/, (req) => (refuse ? Response.json({ ok: false, description: "Too Many Requests: retry after 3", parameters: { retry_after: 3 } }, { status: 429 }) : Response.json({ ok: true, result: { message_id: 9, chat: { id: req.json().chat_id } } })));
    expect(await deliverTelegram(rt)).toBe(0);
    refuse = false;
    expect(await deliverTelegram(rt)).toBe(0);
    rt.clock.move(3_001);
    expect(await deliverTelegram(rt)).toBe(1);
    rt.net.on(/sendMessage$/, () => Response.json({ ok: true, result: { message_id: 10 } }));
  });
});

describe("delivery that keeps failing", () => {
  it("tries five times in all, then gives up and leaves it in the app", async () => {
    const u = await addUser(db, "tg.broken");
    await linkConnections(rt, u, 8800);
    const inst = await installed(rt, u, await notifierAgent(u, "Broken"));
    await enqueue(rt, inst, { kind: "message", text: "x" });
    await runOnce();
    rt.net.on(/sendMessage$/, () => Response.json({ ok: false, description: "Bad Gateway" }, { status: 502 }));
    for (let i = 0; i < 6; i++) await deliverTelegram(rt);
    expect(rt.net.telegram("sendMessage").filter((m) => m.chat_id === 8800)).toHaveLength(5);
    const [m] = await db.select().from(schema.agentMessages).where(eq(schema.agentMessages.installationId, inst.id));
    expect(m).toMatchObject({ tgState: "failed", tgAttempts: 5 });
    expect(rt.logged.some((l) => l.includes("123456:test-bot-token") || l.includes("test-bot-token"))).toBe(false);
    rt.net.on(/sendMessage$/, () => Response.json({ ok: true, result: { message_id: 11 } }));
  });
});

describe("questions with buttons", () => {
  async function asked() {
    await linkConnections(rt, owner, TEST_CHAT_ID).catch(() => undefined);
    const inst = await installed(rt, owner, await publishedAgent(db, owner));
    const job = await enqueue(rt, inst, { kind: "manual" });
    await runOnce();
    const [a] = await approvalsOf(rt, owner.id, { pendingOnly: true });
    return { inst, job, a: a! };
  }

  beforeEach(async () => {
    // The owner's chat for these is the test chat.
    await db.delete(schema.connections).where(eq(schema.connections.ownerUserId, owner.id));
    rt.serve = (ids) => ids[0]!;
  });

  it("asks in the owner's chat with a button per answer", async () => {
    const { a } = await asked();
    await deliverTelegram(rt);
    const [q] = rt.net.telegram("sendMessage");
    expect(q!.chat_id).toBe(TEST_CHAT_ID);
    expect(String(q!.text)).toContain(a.question);
    expect(q!.reply_markup).toEqual({ inline_keyboard: [[{ text: "Yes", callback_data: `a:${a.id}:0` }], [{ text: "No", callback_data: `a:${a.id}:1` }]] });
    const [row] = await db.select().from(schema.agentApprovals).where(eq(schema.agentApprovals.id, a.id));
    expect(row).toMatchObject({ tgState: "sent" });
    expect(row!.tgMessageId).toEqual(expect.any(Number));
  });

  it("a button press answers it, the job goes on, and the app can't answer again", async () => {
    const { a, job } = await asked();
    await deliverTelegram(rt);
    await handleUpdate(rt, press(TEST_CHAT_ID, `a:${a.id}:0`));
    const [row] = await db.select().from(schema.agentApprovals).where(eq(schema.agentApprovals.id, a.id));
    expect(row).toMatchObject({ status: "answered", answer: "Yes", tgState: "closed" });
    expect((await db.select().from(schema.agentJobs).where(eq(schema.agentJobs.id, job.id)))[0]!.status).toBe("queued");
    expect(rt.net.telegram("answerCallbackQuery").at(-1)).toMatchObject({ text: "Answered: Yes" });
    expect(String(rt.net.telegram("editMessageText").at(-1)!.text)).toContain("Answered: Yes.");
    await expect(answer(rt, owner.id, a.id, "No")).rejects.toThrow("It was answered already.");
  });

  it("an answer in the app comes first: the Telegram message then says so, and a late press changes nothing", async () => {
    const { a } = await asked();
    await deliverTelegram(rt);
    await answer(rt, owner.id, a.id, "No");
    await deliverTelegram(rt);
    const edit = rt.net.telegram("editMessageText").at(-1)!;
    expect(edit).toMatchObject({ chat_id: TEST_CHAT_ID });
    expect(String(edit.text)).toContain("Answered: No.");
    expect(edit.reply_markup).toBeUndefined();
    await handleUpdate(rt, press(TEST_CHAT_ID, `a:${a.id}:0`));
    expect(rt.net.telegram("answerCallbackQuery").at(-1)).toMatchObject({ text: "It was answered already." });
    const [row] = await db.select().from(schema.agentApprovals).where(eq(schema.agentApprovals.id, a.id));
    expect(row).toMatchObject({ status: "answered", answer: "No" });
  });

  it("a press from someone else's chat answers nothing", async () => {
    const { a } = await asked();
    await linkConnections(rt, other, 9100).catch(() => undefined);
    await handleUpdate(rt, press(9100, `a:${a.id}:0`));
    await handleUpdate(rt, press(9999, `a:${a.id}:0`));
    const [row] = await db.select().from(schema.agentApprovals).where(eq(schema.agentApprovals.id, a.id));
    expect(row!.status).toBe("pending");
  });

  it("an expired question's message says no answer came", async () => {
    const { a } = await asked();
    await deliverTelegram(rt);
    rt.clock.move(25 * 3_600_000);
    await expireDue(rt);
    await deliverTelegram(rt);
    expect(String(rt.net.telegram("editMessageText").at(-1)!.text)).toContain("No answer came in time.");
    const [row] = await db.select().from(schema.agentApprovals).where(eq(schema.agentApprovals.id, a.id));
    expect(row!.tgState).toBe("closed");
  });
});

describe("owners messaging their agents", () => {
  it("goes straight to the one agent that takes messages", async () => {
    const u = await addUser(db, "tg.one");
    await db.update(schema.users).set({ access: "approved" }).where(eq(schema.users.id, u.id));
    await linkConnections(rt, u, 8400);
    const inst = await installed(rt, u, await notifierAgent(u, "Solo"));
    await handleUpdate(rt, text(8400, "Is the linen low?"));
    const [job] = await db.select().from(schema.agentJobs).where(eq(schema.agentJobs.installationId, inst.id));
    expect(job!.trigger).toMatchObject({ kind: "message", text: "Is the linen low?" });
    expect(replies(8400).at(-1)).toBe("Passed to Solo. It starts on it now.");
    const [m] = await db.select().from(schema.agentMessages).where(eq(schema.agentMessages.installationId, inst.id));
    expect(m).toMatchObject({ from: "owner", tgState: "telegram" });
  });

  it("asks which one when there are several, then passes it on", async () => {
    const u = await addUser(db, "tg.many");
    await db.update(schema.users).set({ access: "approved" }).where(eq(schema.users.id, u.id));
    await linkConnections(rt, u, 8500);
    const first = await installed(rt, u, await notifierAgent(u, "First"));
    const second = await installed(rt, u, await notifierAgent(u, "Second"));
    await handleUpdate(rt, text(8500, "Restock please"));
    const menu = rt.net.telegram("sendMessage").filter((m) => m.chat_id === 8500).at(-1)!;
    expect(menu.text).toBe("Which agent is this for?");
    const buttons = (menu.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard.flat();
    expect(buttons.map((b) => b.text).sort()).toEqual(["First", "Second"]);
    const pick = buttons.find((b) => b.text === "Second")!;
    await handleUpdate(rt, press(8500, pick.callback_data));
    expect(await db.select().from(schema.agentJobs).where(eq(schema.agentJobs.installationId, first.id))).toHaveLength(0);
    const [job] = await db.select().from(schema.agentJobs).where(eq(schema.agentJobs.installationId, second.id));
    expect(job!.trigger).toMatchObject({ kind: "message", text: "Restock please" });
    // The menu works once.
    await handleUpdate(rt, press(8500, pick.callback_data));
    expect(await db.select().from(schema.agentJobs).where(eq(schema.agentJobs.installationId, second.id))).toHaveLength(1);
  });

  it("an unlinked chat is told how to link, and nothing starts", async () => {
    await handleUpdate(rt, text(8600, "hello"));
    expect(replies(8600).at(-1)).toMatch(/isn't linked to boardofserv/);
  });

  it("leaves group chats alone", async () => {
    await handleUpdate(rt, { update_id: updateId++, message: { message_id: 1, from: from(8700), chat: { id: -100, type: "group" }, text: "/start ABC" } });
    expect(rt.net.calls).toHaveLength(0);
  });
});
