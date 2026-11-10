import { z } from "zod";
import { getUserFromRequest } from "@/lib/auth-route";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { ControlRefused } from "@/lib/agents/runtime/installations";
import { marketRefusal } from "@/lib/market/limits";
import { RENTAL_ACTIONS, rentalControl, rentalDetail, rentalOf, RentRefused } from "@/lib/market/rentals";

export const runtime = "nodejs";

const Body = z.object({ action: z.enum(RENTAL_ACTIONS) });

// The renter pauses or resumes what they rent (resuming an unpaid one pays
// the week), cancels it (it runs to the end of the week paid for) or
// takes the cancel back.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const params = await ctx.params;
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const rt = serverRuntime();
  const r = await rentalOf(rt, user.id, params.id);
  if (!r) return Response.json({ error: "Not found" }, { status: 404 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Say pause, resume, cancel or renew." }, { status: 400 });
  // Running costs model spend: only for accounts let in.
  if (parsed.data.action === "resume" || parsed.data.action === "renew") {
    const shut = await marketRefusal(rt, user, { spends: parsed.data.action === "resume" });
    if (shut) return shut;
  }
  try {
    await rentalControl(rt, r, parsed.data.action);
  } catch (err) {
    if (err instanceof RentRefused) return Response.json({ error: err.message }, { status: err.status });
    if (err instanceof ControlRefused) return Response.json({ error: err.message }, { status: 409 });
    throw err;
  }
  return Response.json({ rental: await rentalDetail(rt, (await rentalOf(rt, user.id, params.id))!) });
}
