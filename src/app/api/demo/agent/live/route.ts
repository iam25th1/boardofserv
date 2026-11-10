import { z } from "zod";
import { rateLimited } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.union([
  z.object({ action: z.enum(["pause", "resume", "stop", "run"]) }),
  z.object({ action: z.literal("answer"), approvalId: z.string().uuid(), answer: z.string().min(1).max(80) }),
]);

// Development only: /demo?agent=restock&live=1, the example agent running
// for real on an in-memory database (lib/agents/demoLive.ts). GET gives its
// state (or, with ?page=prices, the suppliers' price page it fetches); POST
// answers its question or works its controls. A 404 anywhere else, and the
// demo itself is not in a production build at all.
export async function GET(req: Request) {
  const limited = rateLimited(req, "demo");
  if (limited) return limited;
  if (process.env.NODE_ENV === "development") {
    const url = new URL(req.url);
    const { demoPage, demoState } = await import("@/lib/agents/demoLive");
    if (url.searchParams.get("page") === "prices") return new Response(demoPage(), { headers: { "content-type": "text/html; charset=utf-8" } });
    return Response.json(await demoState(url.origin, url.searchParams.get("job")));
  }
  return Response.json({ error: "Not found" }, { status: 404 });
}

export async function POST(req: Request) {
  const limited = rateLimited(req, "demo");
  if (limited) return limited;
  if (process.env.NODE_ENV === "development") {
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "Say what to do." }, { status: 400 });
    const { demoAct, demoState } = await import("@/lib/agents/demoLive");
    const origin = new URL(req.url).origin;
    try {
      await demoAct(origin, parsed.data);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "That didn't work." }, { status: 409 });
    }
    return Response.json(await demoState(origin));
  }
  return Response.json({ error: "Not found" }, { status: 404 });
}
