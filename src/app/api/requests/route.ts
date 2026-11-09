import { z } from "zod";
import { getUserFromRequest } from "@/lib/auth-route";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { parseAmount } from "@/lib/money";
import { USDC_DECIMALS } from "@/lib/market/charges";
import { marketRefusal } from "@/lib/market/limits";
import { screenRequest } from "@/lib/safety/moderation";
import { DETAIL_MAX, NEED_MAX, postRequest, requestBoard, RequestRefused, requestsOf } from "@/lib/market/requests";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The request board, for anyone: open requests, most wanted or newest
// first. ?mine=1: the signed-in user's own, open or not.
export async function GET(req: Request) {
  const user = await getUserFromRequest(req).catch(() => null);
  const q = new URL(req.url).searchParams;
  const rt = serverRuntime();
  if (q.get("mine") === "1") {
    if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
    return Response.json({ requests: await requestsOf(rt, user.id) });
  }
  return Response.json({ requests: await requestBoard(rt, { sort: q.get("sort") === "newest" ? "newest" : "wanted", viewerId: user?.id ?? null }) });
}

const Body = z.object({
  need: z.string().max(NEED_MAX * 2),
  detail: z.string().max(DETAIL_MAX * 2).default(""),
  connects: z.array(z.enum(["telegram", "sheets", "web"])).max(3).default([]),
  // A decimal amount of USDC, or empty for none.
  budget: z.string().max(40).default(""),
});

// Ask for an agent.
export async function POST(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const rt = serverRuntime();
  const shut = await marketRefusal(rt, user, { counted: true, spends: true });
  if (shut) return shut;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Say what you need, and what it should connect to." }, { status: 400 });
  const budgetText = parsed.data.budget.trim();
  const budget = budgetText ? parseAmount(budgetText, USDC_DECIMALS) : null;
  if (budgetText && budget === null) return Response.json({ error: "Write the weekly budget like 5 or 7.50, in USDC, or leave it empty." }, { status: 400 });
  try {
    const row = await postRequest(rt, user.id, { need: parsed.data.need, detail: parsed.data.detail, connects: parsed.data.connects, budget });
    // SERV screens it before it goes public; what it holds waits for an admin.
    const screen = await screenRequest(rt, user, row.id, row.need, row.detail);
    return Response.json({ id: row.id, screen }, { status: 201 });
  } catch (err) {
    if (err instanceof RequestRefused) return Response.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
