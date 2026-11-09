import { z } from "zod";
import { eq } from "drizzle-orm";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { agents, agentVersions, users } from "@/lib/db/schema";
import { adminSafety } from "@/lib/safety/admin";
import { freeze, type FreezeKind } from "@/lib/safety/freeze";
import { requireAdmin } from "../guard";

export const runtime = "nodejs";

const Body = z.object({
  kind: z.enum(["agent", "version", "maker", "renter"]),
  // An agent's or a version's id; a maker or renter by id or @handle.
  target: z.string().trim().min(1).max(64),
  reason: z.string().trim().min(3).max(300),
});

// An admin freezes an agent, a version, a maker or a renter, with a
// reason. Admins only.
export async function POST(req: Request) {
  const who = await requireAdmin(req);
  if ("refused" in who) return who.refused;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Say what to freeze, which one, and why (a few words at least)." }, { status: 400 });
  const rt = serverRuntime();
  const id = await resolve(parsed.data.kind, parsed.data.target);
  if (!id) return Response.json({ error: "There's nothing like that to freeze." }, { status: 404 });
  await freeze(rt, who.admin, parsed.data.kind, id, parsed.data.reason);
  return Response.json({ safety: await adminSafety(rt) }, { status: 201 });
}

const isId = (s: string) => /^[0-9a-f-]{36}$/i.test(s);

async function resolve(kind: FreezeKind, target: string): Promise<string | null> {
  const rt = serverRuntime();
  if (kind === "maker" || kind === "renter") {
    const [u] = isId(target) ? await rt.db.select({ id: users.id }).from(users).where(eq(users.id, target)) : await rt.db.select({ id: users.id }).from(users).where(eq(users.handle, target.replace(/^@/, "").toLowerCase()));
    return u?.id ?? null;
  }
  if (!isId(target)) return null;
  const [row] = kind === "agent" ? await rt.db.select({ id: agents.id }).from(agents).where(eq(agents.id, target)) : await rt.db.select({ id: agentVersions.id }).from(agentVersions).where(eq(agentVersions.id, target));
  return row?.id ?? null;
}
