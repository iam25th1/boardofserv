import { z } from "zod";
import { getUserFromRequest } from "@/lib/auth-route";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { rentalDTOs } from "@/lib/market/rentals";
import { marketRefusal } from "@/lib/market/limits";
import { acceptOffer, RequestRefused, withdrawOffer } from "@/lib/market/requests";

export const runtime = "nodejs";

const Body = z.object({ action: z.enum(["accept", "withdraw"]) });

// The one who asked accepts an offer (renting its agent at its price: the
// first week is charged now), or its maker withdraws it.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const params = await ctx.params;
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Say accept or withdraw." }, { status: 400 });
  const rt = serverRuntime();
  try {
    if (parsed.data.action === "withdraw") {
      await withdrawOffer(rt, user.id, params.id);
      return Response.json({ ok: true });
    }
    const shut = await marketRefusal(rt, user, { counted: true, spends: true });
    if (shut) return shut;
    const rental = await acceptOffer(rt, user.id, params.id);
    return Response.json({ rental: (await rentalDTOs(rt, [rental]))[0] }, { status: 201 });
  } catch (err) {
    if (err instanceof RequestRefused) return Response.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
