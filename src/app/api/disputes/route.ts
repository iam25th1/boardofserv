import { z } from "zod";
import { getUserFromRequest } from "@/lib/auth-route";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { notLetIn } from "@/lib/access";
import { DISPUTE_KINDS } from "@/lib/db/schema";
import { DisputeRefused, disputesOf, NOTE_MAX, openDispute } from "@/lib/spending/disputes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  kind: z.enum(DISPUTE_KINDS),
  // The payment's id, or "<rental id>:<week>".
  id: z.string().max(80),
  reason: z.string().max(40),
  note: z.string().max(NOTE_MAX + 200),
});

// A renter's disputes and what they can still dispute: their own alone.
export async function GET(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const shut = notLetIn(user);
  if (shut) return shut;
  return Response.json(await disputesOf(serverRuntime(), user.id));
}

// A renter disputes one of their agent payments or rent weeks, within the
// window, with a reason and a note; it goes to the admin queue. A few open
// at a time, and a few a month.
export async function POST(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const shut = notLetIn(user);
  if (shut) return shut;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Pick the payment or week, a reason, and say what happened." }, { status: 400 });
  const rt = serverRuntime();
  try {
    await openDispute(rt, user, parsed.data);
  } catch (err) {
    if (err instanceof DisputeRefused) return Response.json({ error: err.message }, { status: err.status });
    throw err;
  }
  return Response.json(await disputesOf(rt, user.id), { status: 201 });
}
