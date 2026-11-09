import { serverRuntime } from "@/lib/agents/runtime/context";
import { adminSafety } from "@/lib/safety/admin";
import { requireAdmin } from "../guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The admin's safety page: every code review, and more as it grows. Admins
// only; a 404 for anyone else.
export async function GET(req: Request) {
  const who = await requireAdmin(req);
  if ("refused" in who) return who.refused;
  return Response.json({ safety: await adminSafety(serverRuntime()) });
}
