import { z } from "zod";
import { notLetIn } from "@/lib/access";
import { getUserFromRequest } from "@/lib/auth-route";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { rentalDetail, rentalOf, RentRefused } from "@/lib/market/rentals";
import { answerOffer } from "@/lib/market/versions";

export const runtime = "nodejs";

const Body = z.object({ choice: z.enum(["update", "stay"]) });

// The renter's answer to a new version of what they rent: update to it
// (setupAgain when it needs setting up again), or stay on theirs.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const params = await ctx.params;
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const rt = serverRuntime();
  const r = await rentalOf(rt, user.id, params.id);
  if (!r) return Response.json({ error: "Not found" }, { status: 404 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Say update or stay." }, { status: 400 });
  if (parsed.data.choice === "update") {
    const shut = notLetIn(user);
    if (shut) return shut;
  }
  try {
    const { setupAgain } = await answerOffer(rt, r, parsed.data.choice);
    return Response.json({ rental: await rentalDetail(rt, (await rentalOf(rt, user.id, params.id))!), setupAgain });
  } catch (err) {
    if (err instanceof RentRefused) return Response.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
