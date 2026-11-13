import { eq } from "drizzle-orm";
import { z } from "zod";
import { getUserFromRequest } from "@/lib/auth-route";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { validTimezone } from "@/lib/agents/settingsForm";

export const runtime = "nodejs";

const Body = z.object({ timezone: z.string().min(1).max(64) });

// The signed-in person's time zone, as their browser gives it: saved when
// it changes, and what their agents' times and tests go by from then on.
export async function PUT(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success || !validTimezone(parsed.data.timezone)) return Response.json({ error: "That isn't a time zone." }, { status: 400 });
  if (user.timezone !== parsed.data.timezone) await db.update(users).set({ timezone: parsed.data.timezone, updatedAt: new Date() }).where(eq(users.id, user.id));
  return Response.json({ timezone: parsed.data.timezone });
}
