import { z } from "zod";
import { adminDTO } from "@/lib/payments/admin";
import { chainClient } from "@/lib/payments/chain";
import { setPayoutsPaused } from "@/lib/payments/withdrawals";
import { requireAdmin } from "../guard";

export const runtime = "nodejs";

const Body = z.object({ paused: z.boolean() });

// The switch that pauses every payout, resends included. Takes effect at the
// next payout step, with no restart.
export async function POST(req: Request) {
  const who = await requireAdmin(req);
  if ("refused" in who) return who.refused;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Say whether payouts are paused." }, { status: 400 });
  await setPayoutsPaused(parsed.data.paused, who.admin.id);
  console.info(`payments: payouts ${parsed.data.paused ? "paused" : "resumed"} by an admin.`);
  return Response.json({ admin: await adminDTO(chainClient()) });
}
