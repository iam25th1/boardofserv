import { lessonsByCount } from "@/lib/agents/lessons";
import { requireAdmin } from "../guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// What healing builds learned, the most often learned first (agents/
// lessons.ts). Admins only; a 404 for anyone else.
export async function GET(req: Request) {
  const who = await requireAdmin(req);
  if ("refused" in who) return who.refused;
  return Response.json({ lessons: await lessonsByCount() });
}
