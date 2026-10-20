import { and, asc, desc, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { getUserFromRequest } from "@/lib/auth-route";
import { decryptSecret } from "@/lib/crypto";
import { db } from "@/lib/db";
import { conversations, messages, type Message } from "@/lib/db/schema";
import { getReply, type ChatMessage } from "@/lib/serv";

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
  const chat: ChatMessage[] = history.map((m) => ({ role: m.role, content: m.content }));

  // Name the conversation from its first user message.
  const firstUser = history.find((m) => m.role === "user");
  if (firstUser) {
    const convo = await db.query.conversations.findFirst({ where: eq(conversations.id, cid) });
    if (convo && convo.title === "New conversation") {
      await db.update(conversations).set({ title: titleFrom(firstUser.content) }).where(eq(conversations.id, cid));
    }
  }

  const key = user.openservKeyEncrypted ? safeDecrypt(user.openservKeyEncrypted) : null;
  const controller = new AbortController();
  req.signal.addEventListener("abort", () => controller.abort());

  const stream = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      const enc = new TextEncoder();
      let full = "";
      let source = "fallback";
      let label = "fallback model";
      try {
        const reply = await getReply(chat, key, controller.signal);
        source = reply.source;
        label = reply.label;
        ctrl.enqueue(enc.encode(sse("meta", { conversationId: cid, source, label })));
        for await (const delta of reply.stream) {
          full += delta;
          ctrl.enqueue(enc.encode(sse("delta", { text: delta })));
        }
      } catch {
        if (!full) {
          ctrl.enqueue(enc.encode(sse("error", { message: "The reply could not be completed. You can retry." })));
          ctrl.close();
          return;
        }
      }
      // Persist whatever was produced, including a partial reply after a stop.
      if (full.trim()) {
        const [saved] = await db
          .insert(messages)
          .values({ conversationId: cid, role: "assistant", content: full, source, sourceLabel: label })
          .returning();
        await db.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, cid));
        ctrl.enqueue(enc.encode(sse("done", { messageId: saved?.id, source, label })));
      } else {
        ctrl.enqueue(enc.encode(sse("done", { source, label })));
      }
      ctrl.close();
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

function safeDecrypt(stored: string): string | null {
  try {
    return decryptSecret(stored);
  } catch {
    return null;
  }
}
