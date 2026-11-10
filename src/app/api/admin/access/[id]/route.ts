import { z } from "zod";
import { decideAccess } from "@/lib/access";
import { adminDTO } from "@/lib/payments/admin";
import { chainClient } from "@/lib/payments/chain";
import { requireAdmin } from "../../guard";

export const runtime = "nodejs";

const Body = z.object({ action: z.enum(["approve", "reject"]) });

// An admin lets a waiting account in, or turns it away. Only an account
// still waiting can be decided.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const params = await ctx.params;
  const who = await requireAdmin(req);
  if ("refused" in who) return who.refused;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success || !z.string().uuid().safeParse(params.id).success) return Response.json({ error: "Approve or reject an account." }, { status: 400 });
  const done = await decideAccess(params.id, parsed.data.action === "approve" ? "approved" : "rejected", who.admin.id);
  if (!done) return Response.json({ error: "That account isn't waiting any more." }, { status: 409 });
  console.info(`access: an admin chose ${parsed.data.action} for a waiting account.`);
  return Response.json({ admin: await adminDTO(chainClient()) });
}
