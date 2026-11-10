import { z } from "zod";
import { getUserFromRequest } from "@/lib/auth-route";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { marketRefusal } from "@/lib/market/limits";
import { closeRequest, meToo, requestPage, RequestRefused } from "@/lib/market/requests";
import { rateLimited } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One request and its offers, for anyone.
export async function GET(req: Request, { params }: { params: { id: string } }) {
  const limited = rateLimited(req, "read");
  if (limited) return limited;
  const user = await getUserFromRequest(req).catch(() => null);
  const page = await requestPage(serverRuntime(), params.id, user?.id ?? null);
  if (!page) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(page);
}

const Body = z.object({ action: z.enum(["metoo", "unmetoo", "close"]) });

// "Me too" (or taking it back), or the one who asked closes it.
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Say metoo, unmetoo or close." }, { status: 400 });
  const rt = serverRuntime();
  if (parsed.data.action === "metoo") {
    const shut = await marketRefusal(rt, user, { counted: true });
    if (shut) return shut;
  }
  try {
    if (parsed.data.action === "close") await closeRequest(rt, user.id, params.id);
    else await meToo(rt, user.id, params.id, parsed.data.action === "metoo");
  } catch (err) {
    if (err instanceof RequestRefused) return Response.json({ error: err.message }, { status: err.status });
    throw err;
  }
  return Response.json((await requestPage(rt, params.id, user.id))!);
}
