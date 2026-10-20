import { and, asc, desc, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { getUserFromRequest } from "@/lib/auth-route";
import { db } from "@/lib/db";
import { conversations, messages, replyUsage, type Message } from "@/lib/db/schema";
import { contextFor, CUT_OFF_SUFFIX, modelConfig, streamReply, type ChatMessage, type ReplyResult } from "@/lib/model";
import { parseSketchBlock, SketchSplitter } from "@/lib/sketchBlock";
import type { SketchDTO } from "@/lib/types";

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
  const chat: ChatMessage[] = contextFor(
    history.map((m) => ({ role: m.role, content: m.content })),
    config.historyMessages,
  );

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
      // The sketch block at the end of a reply is cut out here: only the text
      // before it is shown and stored.
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
      const { rest, raw } = split.finish();
      if (result?.cutOff) {
        // Cut off inside the block means the reply itself was complete.
        if (!split.inBlock) show(CUT_OFF_SUFFIX);
      } else {
        show(rest);
      }
      const parsed = parseSketchBlock(raw);
      await recordUsage(cid, result, result?.provider ? parsed !== null : null);

      if (!full.trim()) {
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
      if (parsed) {
        const { choices, ...fields } = parsed;
        const sketch: SketchDTO = { ...fields, live: false };
        send("sketch", { sketch, choices });
      }
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

// One usage row per reply. A failure to record must never break the reply.
async function recordUsage(conversationId: string, r: ReplyResult | null, sketchOk: boolean | null): Promise<void> {
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
    });
  } catch (err) {
    console.error("reply usage not recorded", err instanceof Error ? err.message : "unknown error");
  }
}
