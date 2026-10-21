import { and, asc, desc, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { getUserFromRequest } from "@/lib/auth-route";
import { db } from "@/lib/db";
import { conversations, messages, replyUsage, type Message } from "@/lib/db/schema";
import { contextFor, CUT_OFF_SUFFIX, modelConfig, streamReply, type ChatMessage, type JsonResult, type ReplyResult } from "@/lib/model";
import { mergeSketch, SketchSplitter } from "@/lib/sketchBlock";
import { planTurn } from "@/lib/sketchPlan";
import { loadSketch, saveSketch } from "@/lib/sketchStore";
import { replySystemPrompt, type TurnPlan } from "@/lib/systemPrompt";

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

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "A message is required" }, { status: 400 });
  const { regenerate, editMessageId } = parsed.data;
  const content = parsed.data.content;

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
  const config = modelConfig();
  const context = contextFor(
    history.map((m) => ({ role: m.role, content: m.content })),
    config.historyMessages,
  );
  // The plan call sees only the stored sketch, the reply the person is
  // answering and what they just said.
  const stored = await loadSketch(cid);
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
      const plan = await planTurn({ stored, previous, said }, { config, signal: controller.signal });
      let sketch = stored;
      let turnPlan: TurnPlan | null = null;
      if (plan.sketch) {
        sketch = mergeSketch(stored, plan.sketch);
        await saveSketch(cid, sketch);
        turnPlan = { asking: sketch.asking, choices: sketch.asking ? plan.sketch.choices : [] };
        // The dock fills in now, while the reply is still being written.
        send("sketch", { conversationId: cid, sketch });
      }

      // Then the reply. Its system message carries what the sketch holds and
      // exactly what to ask, in words that fit the buttons.
      const chat: ChatMessage[] = [
        { role: "system", content: replySystemPrompt(sketch, turnPlan) },
        ...context,
      ];
      // Replies no longer write a sketch, but if one still carries the old
      // block or bare sketch JSON, the splitter keeps it off the screen.
      const split = new SketchSplitter();
      let full = "";
      const show = (text: string) => {
        if (!text) return;
        full += text;
        send("delta", { text });
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
          show(split.push(ev.text));
        } else {
          result = ev.result;
        }
      }
      const { rest } = split.finish();
      if (result?.cutOff) {
        // Cut off inside the block means the reply itself was complete.
        if (!split.inBlock) show(CUT_OFF_SUFFIX);
      } else {
        show(rest);
      }

      if (!full.trim()) {
        await recordUsage(cid, result, plan.result, plan.sketch !== null);
        send("error", { message: result?.error ?? "The reply could not be completed. You can retry." });
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
      await recordUsage(cid, result, plan.result, plan.sketch !== null);
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

// One usage row per reply, with the plan call's next to it. A failure
// to record must never break the reply.
async function recordUsage(conversationId: string, r: ReplyResult | null, x: JsonResult | null, sketchOk: boolean | null): Promise<void> {
  if (!r) return;
  try {
    await db.insert(replyUsage).values({
      conversationId,
      provider: r.provider,
      model: r.model,
      promptTokens: r.promptTokens,
      completionTokens: r.completionTokens,
      firstTokenMs: r.firstTokenMs,
      totalMs: r.totalMs,
      outcome: r.outcome,
      sketchOk,
      extractPromptTokens: x?.promptTokens ?? null,
      extractCompletionTokens: x?.completionTokens ?? null,
      extractMs: x?.totalMs ?? null,
      extractOutcome: x?.outcome ?? null,
    });
  } catch (err) {
    console.error("reply usage not recorded", err instanceof Error ? err.message : "unknown error");
  }
}
