import { z } from "zod";
import { getUserFromRequest } from "@/lib/auth-route";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { notLetIn } from "@/lib/access";
import { confirmSuggestion, PayeeRefused, removePayee, savePayee } from "@/lib/spending/payees";
import { spendingOf } from "@/lib/spending/dto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save"), label: z.string().max(80), address: z.string().max(80) }),
  z.object({ action: z.literal("remove"), payeeId: z.string().max(64) }),
  // A payee an agent suggested, confirmed on screen with a name.
  z.object({ action: z.literal("confirm"), payeeId: z.string().max(64), label: z.string().max(80) }),
]);

// An installation's saved payees, its renter's alone (a 404 for anyone
// else): save one (a new address for a name makes a new payee), remove one,
// or confirm one its agent suggested.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const params = await ctx.params;
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const shut = notLetIn(user);
  if (shut) return shut;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Save a payee with a name and a Base address, remove one, or confirm a suggestion." }, { status: 400 });
  const rt = serverRuntime();
  const b = parsed.data;
  try {
    if (b.action === "save") await savePayee(rt, user, params.id, b);
    else if (b.action === "remove") await removePayee(rt, user, params.id, b.payeeId);
    else await confirmSuggestion(rt, user, params.id, b.payeeId, b.label);
  } catch (err) {
    if (err instanceof PayeeRefused) return Response.json({ error: err.message }, { status: err.status });
    throw err;
  }
  return Response.json({ spending: await spendingOf(rt, user, params.id) });
}
