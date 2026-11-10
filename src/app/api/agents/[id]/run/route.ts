import { z } from "zod";
import { notLetIn } from "@/lib/access";
import { recordAgentCall } from "@/lib/agents/build";
import { buildContext, NOT_AVAILABLE } from "@/lib/agents/context";
import { ownedAgent } from "@/lib/agents/owned";
import { runAgent, type RunEvent } from "@/lib/agents/runner";
import { currentVersion } from "@/lib/agents/store";
import { BenchSchema } from "@/lib/agents/toolbox";
import { emptyBench } from "@/lib/agents/types";
import { refusal } from "@/lib/spend";
import { errorText } from "@/lib/db/errors";

export const runtime = "nodejs";

const Body = z.object({ dryRun: z.boolean(), bench: BenchSchema.optional() });

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// One run on the test bench, streamed step by step: the version's own code
// in the sandbox, every tool a mock answering from the bench's data (sent
// with the run, so unsaved edits count). Decisions are SERV's within the
// agent's spend limit, or on a dry run the recorded answers, with no model
// call at all.
export async function POST(req: Request, route: { params: Promise<{ id: string }> }) {
  const params = await route.params;
  const who = await ownedAgent(req, params.id);
  if ("refused" in who) return who.refused;
  const shut = notLetIn(who.user);
  if (shut) return shut;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Say whether it is a dry run, and send sample data the bench can read." }, { status: 400 });
  const version = await currentVersion(who.agent.id);
  const definition = version?.definition;
  if (!version || !definition) return Response.json({ error: "Plan it first." }, { status: 400 });

  const ctx = parsed.data.dryRun ? null : buildContext(who.user, who.agent.sourceConversationId);
  if (!parsed.data.dryRun) {
    if (!ctx) return Response.json({ error: NOT_AVAILABLE }, { status: 503 });
    const no = await refusal(who.user.id, { ownKey: ctx.ownKey });
    if (no) return Response.json(no, { status: 429 });
  }
  const bench = parsed.data.bench ?? version.bench ?? emptyBench();
  const controller = new AbortController();
  req.signal.addEventListener("abort", () => controller.abort());

  const stream = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      const enc = new TextEncoder();
      let open = true;
      const send = (e: RunEvent) => {
        if (!open) return;
        try {
          ctrl.enqueue(enc.encode(sse(e.type, e)));
        } catch {
          open = false;
        }
      };
      try {
        await runAgent({
          definition,
          code: version.code,
          bench,
          dryRun: parsed.data.dryRun,
          serv: ctx?.serv ?? null,
          signal: controller.signal,
          onEvent: send,
          record: ctx ? (call) => recordAgentCall(ctx, "agent_decision", call) : undefined,
        });
      } catch (err) {
        console.error(`agents: a bench run stopped: ${errorText(err, "unknown error")}`);
        send({ type: "end", status: "failed", reason: "The run stopped unexpectedly. Try again.", steps: 0, ms: 0, costUsd: 0, memory: {}, sheets: {} });
      }
      if (open) ctrl.close();
    },
    cancel() {
      controller.abort();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive" } });
}
