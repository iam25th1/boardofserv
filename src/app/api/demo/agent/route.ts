import { z } from "zod";
import { BenchSchema } from "@/lib/agents/toolbox";
import type { RunEvent } from "@/lib/agents/types";
import { rateLimited } from "@/lib/rateLimit";

export const runtime = "nodejs";

const Body = z.object({ bench: BenchSchema });

// Development only: the test bench of /demo?agent=restock, a dry run of the
// example agent with no sign-in and no model call. A 404 anywhere else, and
// the example itself is not in a production build at all.
export async function POST(req: Request) {
  const limited = rateLimited(req, "demo");
  if (limited) return limited;
  if (process.env.NODE_ENV === "development") {
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "The sample data isn't in a shape the bench can read." }, { status: 400 });
    const { runExample } = await import("@/lib/agents/demo");
    const controller = new AbortController();
    req.signal.addEventListener("abort", () => controller.abort());
    const stream = new ReadableStream<Uint8Array>({
      async start(ctrl) {
        const enc = new TextEncoder();
        const send = (e: RunEvent) => ctrl.enqueue(enc.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
        await runExample(parsed.data.bench, send, controller.signal);
        ctrl.close();
      },
      cancel() {
        controller.abort();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform" } });
  }
  return Response.json({ error: "Not found" }, { status: 404 });
}
