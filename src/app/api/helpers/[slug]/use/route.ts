import { z } from "zod";
import { getUserFromRequest } from "@/lib/auth-route";
import { helperSecret, quotaFor, recordUse } from "@/lib/helpers";
import { BLOCKED_MESSAGE, LeakGuard } from "@/lib/leakGuard";
import { CUT_OFF_SUFFIX, modelConfig, SERV_PROMPT_GUARD, streamReply, type ReplyResult } from "@/lib/model";
import type { QuotaDTO } from "@/lib/types";

export const runtime = "nodejs";

const Body = z.object({ input: z.string().trim().min(1).max(4000) });

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// One use of a published helper: a fresh single turn of its system prompt and
// the user's input, nothing else. It runs on SERV with the operator's key and
// declares serv_prompt_guard; the content filter stays on. The answer streams
// through the leak guard, which stops it if it carries the helper's canary or
// a long run of its instructions. The system prompt and canary are never in
// an event or a log.
export async function POST(req: Request, { params }: { params: { slug: string } }) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Sign in to use this helper." }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Give the helper something to work with." }, { status: 400 });

  const helper = await helperSecret(params.slug);
  if (!helper) return Response.json({ error: "Not found" }, { status: 404 });
  if (helper.unpublishedAt) return Response.json({ error: "This helper was taken down." }, { status: 410 });

  const quota = await quotaFor(user.id);
  if (quota.remaining === 0) return Response.json({ error: "No uses left today.", quota }, { status: 429 });

  const base = modelConfig();
  // Uses go to SERV only: a backup model would not know the guard.
  const config = { ...base, providers: base.providers.filter((p) => p.id === "serv") };
  const controller = new AbortController();
  req.signal.addEventListener("abort", () => controller.abort());
  const started = Date.now();

  const stream = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      const enc = new TextEncoder();
      let open = true;
      const send = (event: string, data: unknown) => {
        if (!open) return;
        try {
          ctrl.enqueue(enc.encode(sse(event, data)));
        } catch {
          open = false;
        }
      };
      const guard = new LeakGuard(helper.systemPrompt, helper.canary);
      let shown = "";
      const show = (text: string) => {
        if (!text) return;
        shown += text;
        send("delta", { text });
      };
      let result: ReplyResult | null = null;
      for await (const ev of streamReply(
        [
          { role: "system", content: helper.systemPrompt },
          { role: "user", content: parsed.data.input },
        ],
        { config, signal: controller.signal, servTools: SERV_PROMPT_GUARD },
      )) {
        if (ev.type === "start") send("meta", { source: ev.provider, label: ev.label });
        else if (ev.type === "delta") {
          show(guard.push(ev.text).text);
          // Stop the model as soon as the answer leaks.
          if (guard.blocked) break;
        } else result = ev.result;
      }
      if (!guard.blocked) show(guard.finish().text);

      const outcome = guard.blocked ? "blocked" : shown.trim() && !result?.cutOff ? "ok" : "failed";
      await recordUse({
        helperId: helper.id,
        userId: user.id,
        promptTokens: result?.promptTokens ?? null,
        completionTokens: result?.completionTokens ?? null,
        latencyMs: Date.now() - started,
        outcome,
      });
      const after: QuotaDTO = await quotaFor(user.id);
      if (outcome === "blocked") send("blocked", { message: BLOCKED_MESSAGE, quota: after });
      else if (shown.trim()) {
        if (result?.cutOff) show(CUT_OFF_SUFFIX);
        send("done", { quota: after });
      } else send("error", { message: "The helper could not answer just now. Try again in a minute.", quota: after });
      if (open) ctrl.close();
    },
    cancel() {
      controller.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
