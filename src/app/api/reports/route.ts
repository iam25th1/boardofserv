import { z } from "zod";
import { eq } from "drizzle-orm";
import { getUserFromRequest } from "@/lib/auth-route";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { agents, REPORT_KINDS, REPORT_REASONS } from "@/lib/db/schema";
import { fileReport, ReportRefused } from "@/lib/safety/moderation";

export const runtime = "nodejs";

const Body = z.object({
  kind: z.enum(REPORT_KINDS),
  // The agent, request or offer; a maker by one of their agents.
  targetId: z.string().max(64),
  reason: z.enum(REPORT_REASONS),
  note: z.string().max(1200).default(""),
});

// Anyone signed in reports an agent, a maker, a request or an offer, with a
// reason and a note, once per thing, up to a few a day. It goes to the
// admin queue.
export async function POST(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Sign in to report it." }, { status: 401 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Pick a reason, and add a note if you like." }, { status: 400 });
  const rt = serverRuntime();
  let targetId = parsed.data.targetId;
  // A maker is reported from one of their agents: never by their account id.
  if (parsed.data.kind === "maker") {
    const [a] = /^[0-9a-f-]{36}$/i.test(targetId) ? await rt.db.select({ owner: agents.ownerUserId }).from(agents).where(eq(agents.id, targetId)) : [];
    if (!a) return Response.json({ error: "There's nothing like that to report." }, { status: 404 });
    targetId = a.owner;
  }
  try {
    await fileReport(rt, user, { ...parsed.data, targetId });
    return Response.json({ ok: true }, { status: 201 });
  } catch (err) {
    if (err instanceof ReportRefused) return Response.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
