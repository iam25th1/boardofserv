import { eq } from "drizzle-orm";
import { z } from "zod";
import { getUserFromRequest } from "@/lib/auth-route";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { validTimezone } from "@/lib/agents/settingsForm";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { followZone } from "@/lib/agents/runtime/installations";

export const runtime = "nodejs";

// chosen: true when the person picked it in their account's settings,
// false to follow their browser again; left out, it is what their browser
// says, at sign in and whenever it changes.
const Body = z.object({ timezone: z.string().min(1).max(64), chosen: z.boolean().optional() });

// The signed-in person's time zone: their browser's until they choose one,
// which then stays whatever a browser says. Their agents' times, runs and
// tests go by it, and every copy of an agent they run moves to it.
export async function PUT(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success || !validTimezone(parsed.data.timezone)) return Response.json({ error: "That isn't a time zone." }, { status: 400 });
  const { timezone, chosen } = parsed.data;
  // A browser never changes a zone its owner chose.
  if (chosen === undefined && user.timezoneChosen) return Response.json({ timezone: user.timezone, chosen: true });
  const keep = chosen ?? false;
  if (user.timezone !== timezone || user.timezoneChosen !== keep) await db.update(users).set({ timezone, timezoneChosen: keep, updatedAt: new Date() }).where(eq(users.id, user.id));
  if (user.timezone !== timezone) await followZone(serverRuntime(), user.id, timezone);
  return Response.json({ timezone, chosen: keep });
}
