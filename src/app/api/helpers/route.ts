import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { getUserFromRequest } from "@/lib/auth-route";
import { db } from "@/lib/db";
import { conversations, messages, publishedHelpers, users } from "@/lib/db/schema";
import { compileHelper, freeSlug, guardLine, isUniqueViolation, liveHelperFor, newCanary, PUBLIC_COLUMNS, publicHelper } from "@/lib/helpers";
import { modelConfig } from "@/lib/model";
import { fieldsOf } from "@/lib/sketchFields";
import { loadSketch } from "@/lib/sketchStore";

export const runtime = "nodejs";

// The confirm sheet's edits: one line about the helper and the hint shown in
// the box people type into. Both are public.
const oneLine = (max: number) =>
  z
    .string()
    .transform((s) => s.replace(/\s+/g, " ").trim())
    .pipe(z.string().min(1).max(max));

const Body = z.object({
  conversationId: z.string().uuid(),
  description: oneLine(140),
  inputHint: oneLine(80),
});

// Publish the answer helper sketched in a conversation: compile its private
// system prompt, then put it on the board. The response, like every other,
// carries the public helper only.
export async function POST(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "A description and a hint are required" }, { status: 400 });
  const { conversationId, description, inputHint } = parsed.data;

  const convo = await db.query.conversations.findFirst({
    where: and(eq(conversations.id, conversationId), eq(conversations.userId, user.id)),
  });
  if (!convo) return Response.json({ error: "Not found" }, { status: 404 });

  const sketch = await loadSketch(conversationId);
  if (!sketch?.name || sketch.kind !== "answer" || !fieldsOf("answer").every((k) => sketch[k])) {
    return Response.json({ error: "Finish describing the helper first." }, { status: 400 });
  }
  const live = await liveHelperFor(conversationId);
  if (live) return Response.json({ error: "This helper is already on the board.", helper: live }, { status: 409 });

  const history = await db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt));
  const config = modelConfig();
  const controller = new AbortController();
  req.signal.addEventListener("abort", () => controller.abort());
  const { prompt } = await compileHelper(sketch, history, { config, signal: controller.signal });
  if (!prompt) {
    const error = config.providers.length
      ? "Its instructions could not be written just now. Try again in a minute."
      : "No model is set up, so the helper can't be published yet.";
    return Response.json({ error }, { status: 502 });
  }

  const canary = newCanary();
  const values = {
    ownerUserId: user.id,
    name: sketch.name,
    description,
    inputHint,
    systemPrompt: `${prompt}\n\n${guardLine(canary)}`,
    canary,
    sourceConversationId: conversationId,
  };
  // Two publishes can race for a slug; the loser takes the next free one.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const slug = await freeSlug(sketch.name);
      const [row] = await db.insert(publishedHelpers).values({ ...values, slug }).returning({ slug: publishedHelpers.slug });
      const [saved] = await db
        .select(PUBLIC_COLUMNS)
        .from(publishedHelpers)
        .innerJoin(users, eq(users.id, publishedHelpers.ownerUserId))
        .where(eq(publishedHelpers.slug, row!.slug));
      return Response.json({ helper: publicHelper(saved!) });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const raced = await liveHelperFor(conversationId);
      if (raced) return Response.json({ error: "This helper is already on the board.", helper: raced }, { status: 409 });
    }
  }
  return Response.json({ error: "It could not be published just now. Try again." }, { status: 503 });
}
