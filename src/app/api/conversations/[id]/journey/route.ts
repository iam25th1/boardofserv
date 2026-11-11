import { z } from "zod";
import { notLetIn } from "@/lib/access";
import { getUserFromRequest } from "@/lib/auth-route";
import { setupShapeOf } from "@/lib/agents/definition";
import { addCard, cardsIn, conversationOf, updateCard } from "@/lib/agents/journey";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { checkAnswers } from "@/lib/agents/settingsForm";
import { agentForConversation, currentVersion } from "@/lib/agents/store";
import { hasConnection } from "@/lib/connections/vault";
import { connectionsNeeded, spends } from "@/lib/agents/definition";
import { diagnosed } from "@/lib/agents/build";
import { connectDiagnosis } from "@/lib/agents/diagnosis";

export const runtime = "nodejs";

const Answers = z.object({
  settings: z.record(z.string(), z.unknown()),
  rules: z.record(z.string(), z.string().max(200)),
  timezone: z.string().max(64),
  schedule: z.object({ at: z.string().max(5).nullable(), day: z.number().int().nullable(), days: z.array(z.number().int()).max(7).nullable().optional(), interval: z.number().int().nullable().optional() }).nullable().optional(),
  payee: z.object({ label: z.string().trim().min(1).max(40), address: z.string().trim().max(80) }).nullable().optional(),
});
const Body = z.object({ action: z.literal("connect"), answers: Answers });

// Connect, in the chat: the answers the agent needs (which sheet, the page
// link, the target) and who it pays, checked as its setup checks them, with
// Telegram linked and Google connected where it needs them. Saved on the
// Connect card, then Go live is offered.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const params = await ctx.params;
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const shut = notLetIn(user);
  if (shut) return shut;
  const convo = await conversationOf(user, params.id);
  if (!convo) return Response.json({ error: "Not found" }, { status: 404 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Send the answers it needs." }, { status: 400 });
  const agent = await agentForConversation(convo.id);
  const version = agent ? await currentVersion(agent.id) : null;
  const d = version?.definition;
  if (!agent || !d) return Response.json({ error: "There's nothing to connect yet." }, { status: 409 });
  const card = (await cardsIn(convo.id)).filter((m) => m.card?.stage === "connect").at(-1);
  if (!card?.card) return Response.json({ error: "Try it first: you connect it once its test passes." }, { status: 409 });

  const a = parsed.data.answers;
  const checked = checkAnswers(setupShapeOf(d), { settings: a.settings, rules: a.rules, timezone: a.timezone, schedule: a.schedule ?? null });
  const errors: Record<string, string> = checked.ok ? {} : { ...checked.errors };
  const pays = d.actions.some(spends);
  if (pays && !a.payee) errors.payee = "Say who it pays: a name and their Base address.";
  if (a.payee && !/^0x[0-9a-fA-F]{40}$/.test(a.payee.address)) errors.payee = "That isn't a Base address: it starts 0x and has 40 more letters and digits.";
  const rt = serverRuntime();
  const needs = connectionsNeeded(d);
  if (needs.telegram && rt.services.telegramToken && !(await hasConnection(rt, user.id, "telegram"))) errors.telegram = "Link your Telegram first.";
  if (needs.google && rt.services.google && !(await hasConnection(rt, user.id, "google"))) errors.google = "Connect Google first.";
  if (Object.keys(errors).length) {
    await diagnosed(version.id, connectDiagnosis(d, errors));
    return Response.json({ error: "Some answers need another look.", errors }, { status: 400 });
  }

  await updateCard(card.id, { ...card.card, answers: { ...a, payee: a.payee ?? null } }, "Connected: it has what it needs.");
  const latest = (await cardsIn(convo.id)).at(-1);
  if (latest?.card?.stage === "connect") await addCard(convo.id, { stage: "live", agentId: agent.id }, "Ready to go live.");
  return Response.json({ ok: true });
}
