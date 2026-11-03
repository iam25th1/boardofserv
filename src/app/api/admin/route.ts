import { adminDTO } from "@/lib/payments/admin";
import { chainClient } from "@/lib/payments/chain";
import { requireAdmin } from "./guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Everything the admin page shows: the treasury against what is owed, the
// withdrawals waiting for approval, payout history, unmatched deposits and
// whether payouts are paused.
export async function GET(req: Request) {
  const who = await requireAdmin(req);
  if ("refused" in who) return who.refused;
  return Response.json({ admin: await adminDTO(chainClient()) });
}
