import { and, asc, desc, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { notLetIn } from "@/lib/access";
import { getUserFromRequest } from "@/lib/auth-route";
import { DashFix } from "@/lib/dashes";
import { db } from "@/lib/db";
import { conversations, messages, replyUsage, type Message } from "@/lib/db/schema";
import { contextFor, CUT_OFF_SUFFIX, modelConfig, streamReply, userError, type ChatMessage, type JsonResult, type ReplyResult } from "@/lib/model";
import { mergeSketch, SketchSplitter } from "@/lib/sketchBlock";
import { planTurn } from "@/lib/sketchPlan";
import { loadSketch, saveSketch } from "@/lib/sketchStore";
import { servKeyOf } from "@/lib/servKey";
import { refusal } from "@/lib/spend";
import { replySystemPrompt, type TurnPlan } from "@/lib/systemPrompt";
import { errorText } from "@/lib/db/errors";
import { recordAttempts } from "@/lib/modelAttempts";
import { agentForConversation, currentVersion } from "@/lib/agents/store";
import { changePlan, type Changed } from "@/lib/agents/change";
import { honestReply } from "@/lib/replyClaims";

export const runtime = "nodejs";

const Body = z.object({
  conversationId: z.string().uuid().optional(),
  content: z.string().trim().min(1).max(8000).optional(),
  regenerate: z.boolean().optional(),
  editMessageId: z.string().uuid().optional(),
});

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function titleFrom(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= 48 ? clean : `${clean.slice(0, 47).trimEnd()}...`;
}

export async function POST(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  // Not let in yet: nothing here runs for a waiting account.
  const shut = notLetIn(user);
  if (shut) return shut;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "A message is required" }, { status: 400 });
  const { regenerate, editMessageId } = parsed.data;
  const content = parsed.data.content;

  // Every turn is a reply: refuse it before anything is stored when the day's
  // limits are reached.
  const config = modelConfig(process.env, { servKey: servKeyOf(user) });
  const ownKey = Boolean(config.ownKey);
  const no = await refusal(user.id, { ownKey, chat: true });
  if (no) return Response.json(no, { status: 429 });

  // Resolve the conversation, creating one on the first message.
  let conversationId = parsed.data.conversationId;
  if (!conversationId) {
    const [created] = await db.insert(conversations).values({ userId: user.id }).returning();
    conversationId = created?.id;
  } else {
    const convo = await db.query.conversations.findFirst({
      where: and(eq(conversations.id, conversationId), eq(conversations.userId, user.id)),
    });
    if (!convo) return Response.json({ error: "Not found" }, { status: 404 });
  }
  if (!conversationId) return Response.json({ error: "Could not open a conversation" }, { status: 500 });
  const cid: string = conversationId;

  // Apply the edit, regenerate or new-message intent to stored history.
  if (editMessageId && content) {
    const target = await db.query.messages.findFirst({ where: eq(messages.id, editMessageId) });
    if (target && target.conversationId === cid) {
      await db.update(messages).set({ content }).where(eq(messages.id, editMessageId));
      await db.delete(messages).where(and(eq(messages.conversationId, cid), gt(messages.createdAt, target.createdAt)));
    }
  } else if (regenerate) {
    const last = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, cid))
      .orderBy(desc(messages.createdAt))
      .limit(1);
    if (last[0]?.role === "assistant") await db.delete(messages).where(eq(messages.id, last[0].id));
  } else if (content) {
    await db.insert(messages).values({ conversationId: cid, role: "user", content });
  }

  // Build the model context from stored history.
  const history: Message[] = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, cid))
    .orderBy(asc(messages.createdAt));
  const context = contextFor(
    history.map((m) => ({ role: m.role, content: m.content })),
    config.historyMessages,
  );
  // The plan call sees only the stored sketch, the reply the person is
  // answering and what they just said.
  const stored = await loadSketch(cid);
  // The agent planned from this conversation, if there is one: once it has
  // steps, what the person says may be a change to them.
  const built = await agentForConversation(cid);
  const planned = built ? Boolean((await currentVersion(built.id))?.definition) : false;
  const at = context.map((m) => m.role).lastIndexOf("user");
  const said = context[at]?.content ?? "";
  const previous = context.slice(0, Math.max(at, 0)).reverse().find((m) => m.role === "assistant")?.content ?? null;

  // Name the conversation from its first user message.
  const firstUser = history.find((m) => m.role === "user");
  if (firstUser) {
    const convo = await db.query.conversations.findFirst({ where: eq(conversations.id, cid) });
    if (convo && convo.title === "New conversation") {
      await db.update(conversations).set({ title: titleFrom(firstUser.content) }).where(eq(conversations.id, cid));
    }
  }

  const controller = new AbortController();
  req.signal.addEventListener("abort", () => controller.abort());
  const usageId = await startUsage(cid, user.id, ownKey);

  const stream = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      const enc = new TextEncoder();
      let open = true;
      const send = (event: string, data: unknown) => {
        if (!open) return;
        try {
          ctrl.enqueue(enc.encode(sse(event, data)));
        } catch {
          open = false; // the browser went away; keep going so the reply is saved
        }
      };
      // First the plan: the sketch from what the person just said, and what the
      // reply asks next with the answers shown as buttons. If it fails or does
      // not validate, the reply runs on the stored sketch with no buttons.
      const plan = await planTurn({ stored, previous, said, planned }, { config, signal: controller.signal });
      let sketch = stored;
      let turnPlan: TurnPlan | null = null;
      if (plan.sketch) {
        sketch = mergeSketch(stored, plan.sketch);
        await saveSketch(cid, sketch);
        turnPlan = { asking: sketch.asking, choices: sketch.asking ? plan.sketch.choices : [] };
        // The dock fills in now, while the reply is still being written.
        send("sketch", { conversationId: cid, sketch });
      }

      // A change asked for an agent that has steps goes the way "Change the
      // plan" on its page does (agents/change.ts), and the reply says only
      // what really happened: no model writes it.
      const change = planned && built ? (plan.sketch?.change ?? null) : null;
      if (change && built) {
        const changed = await changePlan(user, built, { message: said });
        if (changed.kind === "started" || changed.kind === "busy") send("agent", { conversationId: cid, agent: changed.agent });
        const text = changeReply(changed, change);
        send("delta", { text });
        const [saved] = await db.insert(messages).values({ conversationId: cid, role: "assistant", content: text }).returning();
        await db.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, cid));
        send("reply_end", { messageId: saved?.id, source: null, label: null, choices: [] });
        await finishUsage(usageId, null, plan.result, plan.sketch !== null, ownKey, "ok");
        send("done", { messageId: saved?.id, source: null, label: null });
        if (open) ctrl.close();
        return;
      }

      // Then the reply. Its system message carries what the sketch holds and
      // exactly what to ask, in words that fit the buttons.
      const chat: ChatMessage[] = [
        { role: "system", content: replySystemPrompt(sketch, turnPlan, planned) },
        ...context,
      ];
      // Replies no longer write a sketch, but if one still carries the old
      // block or bare sketch JSON, the splitter keeps it off the screen.
      const split = new SketchSplitter();
      // No em dashes on screen, code left alone (dashes.ts).
      const dashes = new DashFix();
      let full = "";
      // About an agent with steps, the reply is held until it is whole and
      // checked (replyClaims.ts): it may not say it changed, tested or
      // published anything, or point at a Plan button the card doesn't have.
      const show = (text: string) => {
        if (!text) return;
        full += text;
        if (!planned) send("delta", { text });
      };
      let source = "";
      let label = "";
      let result: ReplyResult | null = null;
      for await (const ev of streamReply(chat, { config, signal: controller.signal })) {
        if (ev.type === "start") {
          source = ev.provider;
          label = ev.label;
          send("meta", { conversationId: cid, source, label });
        } else if (ev.type === "delta") {
          show(dashes.push(split.push(ev.text)));
        } else {
          result = ev.result;
        }
      }
      const { rest } = split.finish();
      if (result?.cutOff) {
        show(dashes.finish());
        // Cut off inside the block means the reply itself was complete.
        if (!split.inBlock) show(CUT_OFF_SUFFIX);
      } else {
        show(dashes.push(rest) + dashes.finish());
      }

      if (planned && full.trim()) {
        full = honestReply(full);
        send("delta", { text: full });
      }
      if (!full.trim()) {
        await finishUsage(usageId, result, plan.result, plan.sketch !== null, ownKey);
        // The details stay in the server's log; the thread gets one plain sentence.
        console.error(`chat: no reply. ${result?.error ?? "The reply ended with nothing to show."}`);
        send("error", { message: userError(result?.failures ?? [], ownKey) });
        if (open) ctrl.close();
        return;
      }
      // Persist whatever was produced, including a partial reply after a stop.
      const [saved] = await db
        .insert(messages)
        .values({ conversationId: cid, role: "assistant", content: full.trimEnd(), source, sourceLabel: label })
        .returning();
      await db.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, cid));
      // The reply is finished and saved: the browser unlocks the composer and
      // shows the plan's answers under it.
      send("reply_end", { messageId: saved?.id, source, label, choices: turnPlan?.choices ?? [] });
      await finishUsage(usageId, result, plan.result, plan.sketch !== null, ownKey);
      send("done", { messageId: saved?.id, source, label });
      if (open) ctrl.close();
    },
    cancel() {
      controller.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}

// One usage row per reply, with the plan call's next to it. The row is
// written as the turn starts, so turns running at the same time all count
// against the day's limit, and finished when the reply ends. A failure to
// record must never break the reply.
async function startUsage(conversationId: string, userId: string, ownKey: boolean): Promise<string | null> {
  try {
    const [row] = await db
      .insert(replyUsage)
      .values({ conversationId, userId, ownKey, kind: "reply", totalMs: 0, outcome: "ok" })
      .returning({ id: replyUsage.id });
    return row?.id ?? null;
  } catch (err) {
    console.error("reply usage not recorded", errorText(err, "unknown error"));
    return null;
  }
}

async function finishUsage(id: string | null, r: ReplyResult | null, x: JsonResult | null, sketchOk: boolean | null, ownKey: boolean, outcome?: "ok"): Promise<void> {
  // Each try of the plan call and of the reply, in the attempt log.
  if (x) await recordAttempts(db as never, x.attempts, { ownKey });
  if (r) await recordAttempts(db as never, r.attempts, { ownKey });
  if (!id) return;
  try {
    await db
      .update(replyUsage)
      .set({
        provider: r?.provider ?? null,
        model: r?.model ?? null,
        promptTokens: r?.promptTokens ?? null,
        completionTokens: r?.completionTokens ?? null,
        firstTokenMs: r?.firstTokenMs ?? null,
        totalMs: r?.totalMs ?? 0,
        outcome: outcome ?? r?.outcome ?? "failed",
        sketchOk,
        extractPromptTokens: x?.promptTokens ?? null,
        extractCompletionTokens: x?.completionTokens ?? null,
        extractMs: x?.totalMs ?? null,
        extractOutcome: x?.outcome ?? null,
        extractProvider: x?.provider ?? null,
        extractModel: x?.model ?? null,
      })
      .where(eq(replyUsage.id, id));
  } catch (err) {
    console.error("reply usage not recorded", errorText(err, "unknown error"));
  }
}

// What the chat says about a change asked for an agent with steps: exactly
// what happened, never more.
function changeReply(changed: Changed, change: string): string {
  const what = change.replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "");
  if (changed.kind === "started") return `Changing the plan: ${what}. The agent's card shows the new steps when it's done.`;
  if (changed.kind === "busy") return "It's still being built, so nothing has changed yet. Ask again once its card says it's ready.";
  if (changed.kind === "unplanned") return "There's no plan to change yet.";
  return `${changed.error} Nothing has changed.`;
}
