import { z } from "zod";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { adminSafety } from "@/lib/safety/admin";
import { moderate } from "@/lib/safety/moderation";
import { requireAdmin } from "../guard";

export const runtime = "nodejs";

const Body = z.object({
  type: z.enum(["report", "listing", "request", "offer", "reppo", "payment"]),
  id: z.string().max(64),
  action: z.enum(["approve", "hide", "freeze"]),
  reason: z.string().trim().min(3).max(300),
});

// An admin works the queue: approves (nothing wrong), hides, or freezes
// what is behind an item, with a reason. Admins only.
export async function POST(req: Request) {
  const who = await requireAdmin(req);
  if ("refused" in who) return who.refused;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Say approve, hide or freeze, and why (a few words at least)." }, { status: 400 });
  const rt = serverRuntime();
  const done = await moderate(rt, who.admin, { type: parsed.data.type, id: parsed.data.id }, parsed.data.action, parsed.data.reason);
  if (!done) return Response.json({ error: "It isn't waiting in the queue." }, { status: 409 });
  return Response.json({ safety: await adminSafety(rt) });
}
