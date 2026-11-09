import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { notLetIn } from "@/lib/access";
import { getUserFromRequest } from "@/lib/auth-route";
import { db } from "@/lib/db";
import { conversations, messages, publishedHelpers, replyUsage, users } from "@/lib/db/schema";
import { compileHelper, freeSlug, guardLine, liveHelperFor, newCanary, PUBLIC_COLUMNS, withPrices } from "@/lib/helpers";
import { PricesBody, readPrices } from "@/lib/payments/prices";
import { setPrices } from "@/lib/payments/uses";
import { isUniqueViolation } from "@/lib/users";
import { describeFailures, modelConfig, userError } from "@/lib/model";
import { DESCRIPTION_MAX, fieldsOf } from "@/lib/sketchFields";
import { loadSketch } from "@/lib/sketchStore";
import { servKeyOf } from "@/lib/servKey";
import { refusal } from "@/lib/spend";

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
  description: oneLine(DESCRIPTION_MAX),
  inputHint: oneLine(80),
  // A price per use in each currency the maker accepts, in minor units.
  prices: PricesBody.optional(),
});

// Publish the answer helper sketched in a conversation: compile its private
// system prompt, then put it on the board. The response, like every other,
// carries the public helper only.
export async function POST(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  // Not let in yet: nothing here runs for a waiting account.
  const shut = notLetIn(user);
  if (shut) return shut;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "A description and a hint are required" }, { status: 400 });
  const { conversationId, description, inputHint } = parsed.data;
  const prices = readPrices(parsed.data.prices ?? {});
  if ("error" in prices) return Response.json({ error: prices.error }, { status: 400 });

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
  const config = modelConfig(process.env, { servKey: servKeyOf(user) });
  const no = await refusal(user.id, { ownKey: Boolean(config.ownKey) });
  if (no) return Response.json(no, { status: 429 });

  const history = await db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt));
  const controller = new AbortController();
  req.signal.addEventListener("abort", () => controller.abort());
  const { prompt, result } = await compileHelper(sketch, history, { config, signal: controller.signal });
  // The compile call's tokens count towards the day's spend.
  try {
    await db.insert(replyUsage).values({
      conversationId,
      userId: user.id,
      kind: "compile",
      ownKey: Boolean(config.ownKey),
      provider: result.provider,
      model: result.model,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      totalMs: result.totalMs,
      outcome: result.outcome,
    });
  } catch (err) {
    console.error("compile usage not recorded", err instanceof Error ? err.message : "unknown error");
  }
  if (!prompt) {
    // The details stay in the server's log.
    console.error(`publish: no instructions written. ${result.content ? "The model's answer did not validate." : describeFailures(result.failures, config.firstTokenTimeoutMs)}`);
    const error = config.providers.length
      ? userError(result.failures, Boolean(config.ownKey), "Its instructions could not be written just now. Try again in a minute.")
      : "Publishing isn't available right now. Try again in a few minutes.";
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
      const [row] = await db.insert(publishedHelpers).values({ ...values, slug }).returning({ id: publishedHelpers.id, slug: publishedHelpers.slug });
      await setPrices(row!.id, prices.prices);
      const [saved] = await db
        .select(PUBLIC_COLUMNS)
        .from(publishedHelpers)
        .innerJoin(users, eq(users.id, publishedHelpers.ownerUserId))
        .where(eq(publishedHelpers.slug, row!.slug));
      return Response.json({ helper: (await withPrices([saved!]))[0] });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const raced = await liveHelperFor(conversationId);
      if (raced) return Response.json({ error: "This helper is already on the board.", helper: raced }, { status: 409 });
    }
  }
  return Response.json({ error: "It could not be published just now. Try again." }, { status: 503 });
}
