import { z } from "zod";
import { count, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { paymentAlerts } from "@/lib/db/schema";
import { adminDTO } from "@/lib/payments/admin";
import { chainClient } from "@/lib/payments/chain";
import { setPaymentsPaused } from "@/lib/spending/treasury";
import { requireAdmin } from "../guard";

export const runtime = "nodejs";

const Body = z.object({ paused: z.boolean(), reason: z.string().trim().max(300).optional() });

// The site wide switch for agents' payments: off, nothing new is held or
// sent (a payment already sent still settles). It can't be turned back on
// while a payment alert is open: an admin looks into those first, in the
// safety queue. Admins only.
export async function POST(req: Request) {
  const who = await requireAdmin(req);
  if ("refused" in who) return who.refused;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Say whether agent payments are paused, and why in a few words." }, { status: 400 });
  if (!parsed.data.paused) {
    const [open] = await db.select({ n: count() }).from(paymentAlerts).where(eq(paymentAlerts.status, "open"));
    if ((open?.n ?? 0) > 0) return Response.json({ error: "Look into the open payment alerts in the safety queue first, then turn agent payments back on." }, { status: 409 });
  }
  await setPaymentsPaused(db, parsed.data.paused ? parsed.data.reason || "An admin paused agent payments." : null, who.admin.id);
  console.info(`payments: agent payments ${parsed.data.paused ? "paused" : "resumed"} by an admin.`);
  return Response.json({ admin: await adminDTO(chainClient()) });
}
