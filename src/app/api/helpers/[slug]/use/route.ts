import { z } from "zod";
import { getUserFromRequest } from "@/lib/auth-route";
import { finishUse, helperSecret, quotaFor, startUse } from "@/lib/helpers";
import { BLOCKED_MESSAGE, LeakGuard } from "@/lib/leakGuard";
import { CUT_OFF_SUFFIX, modelConfig, SERV_PROMPT_GUARD, streamReply, type ReplyResult } from "@/lib/model";
import { CURRENCIES, formatAmount, type Currency } from "@/lib/money";
import { paymentsConfig } from "@/lib/payments/config";
import { balancesOf } from "@/lib/payments/ledger";
import { capture, pricesOf, release, reserve, type Hold } from "@/lib/payments/uses";
import { servKeyOf } from "@/lib/servKey";
import { refusal } from "@/lib/spend";
import type { BalanceDTO, PriceDTO, QuotaDTO } from "@/lib/types";

export const runtime = "nodejs";

const Body = z.object({
  input: z.string().trim().min(1).max(4000),
  currency: z.enum(CURRENCIES).optional(),
  // The price the page showed, in minor units: a paid use is only charged at
  // the price the user saw.
  price: z.string().regex(/^\d{1,78}$/).optional(),
});

async function balanceIn(userId: string, currency: Currency): Promise<BalanceDTO> {
  const b = (await balancesOf(userId))[currency];
  return { currency, available: b.available.toString(), held: b.held.toString() };
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// One use of a published helper: a fresh single turn of its system prompt and
// the user's input, nothing else. It runs on SERV with the operator's key (or
// the user's own SERV key, when they have set one) and
// declares serv_prompt_guard; the content filter stays on. The answer streams
// through the leak guard, which stops it if it carries the helper's canary or
// a long run of its instructions. The system prompt and canary are never in
// an event or a log.
//
// A helper with prices is paid for from the balance the user picks: the
// price is held before the model is called, captured on a good answer and
// released on a failed or blocked one. A helper without prices is free, with
// the daily limit.
export async function POST(req: Request, { params }: { params: { slug: string } }) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Sign in to use this helper." }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Give the helper something to work with." }, { status: 400 });

  const helper = await helperSecret(params.slug);
  if (!helper) return Response.json({ error: "Not found" }, { status: 404 });
  if (helper.unpublishedAt) return Response.json({ error: "This helper was taken down." }, { status: 410 });
  const base = modelConfig(process.env, { servKey: servKeyOf(user) });
  const ownKey = Boolean(base.ownKey);
  const no = await refusal(user.id, { ownKey });
  if (no) return Response.json(no, { status: 429 });

  const prices = (await pricesOf([helper.id])).get(helper.id) ?? [];
  let hold: Hold | null = null;
  if (prices.length) {
    const price = prices.find((p) => p.currency === parsed.data.currency);
    if (!price) {
      return Response.json({ error: `Pick a balance to pay from: ${prices.map((p) => p.currency).join(" or ")}.` }, { status: 400 });
    }
    if (parsed.data.price !== price.amount.toString()) {
      const decimals = paymentsConfig().currencies[price.currency].decimals;
      const now: PriceDTO[] = prices.map((p) => ({ currency: p.currency, amount: p.amount.toString(), decimals: paymentsConfig().currencies[p.currency].decimals }));
      return Response.json(
        { error: `The price is now ${formatAmount(price.amount, decimals)} ${price.currency} a use. Check it and ask again.`, prices: now },
        { status: 409 },
      );
    }
    hold = await reserve({ userId: user.id, helperId: helper.id, makerUserId: helper.ownerUserId, currency: price.currency, amount: price.amount });
    if (!hold) {
      return Response.json(
        { error: `Not enough ${price.currency}. Top up your wallet to use this helper.`, balance: await balanceIn(user.id, price.currency) },
        { status: 402 },
      );
    }
  } else {
    const quota = await quotaFor(user.id);
    if (quota.remaining === 0) return Response.json({ error: "No uses left today.", quota }, { status: 429 });
  }

  // Uses go to SERV only (on the person's own key when they have one): a
  // backup model would not know the guard.
  const config = { ...base, providers: base.providers.filter((p) => p.id === "serv") };
  const controller = new AbortController();
  req.signal.addEventListener("abort", () => controller.abort());
  const started = Date.now();
  const useId = await startUse(helper.id, user.id, hold?.id ?? null, ownKey);

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
      try {
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
      } catch {
        // Whatever broke, the use still ends with an event and a record.
        controller.abort();
      }

      const outcome = guard.blocked ? "blocked" : shown.trim() ? "ok" : "failed";
      await finishUse(useId, {
        promptTokens: result?.promptTokens ?? null,
        completionTokens: result?.completionTokens ?? null,
        provider: result?.provider ?? null,
        model: result?.model ?? null,
        latencyMs: Date.now() - started,
        outcome,
      });
      // A good answer is paid for; a blocked or failed one costs nothing.
      if (hold) {
        try {
          if (outcome === "ok") await capture(hold.id);
          else await release(hold.id);
        } catch (err) {
          // The sweep gives the hold back if it is still held.
          console.error(`payments: a use's hold was not settled: ${err instanceof Error ? err.name : "unknown error"}`);
        }
      }
      const after: { quota: QuotaDTO } | { balance: BalanceDTO } = hold ? { balance: await balanceIn(user.id, hold.currency) } : { quota: await quotaFor(user.id) };
      if (outcome === "blocked") send("blocked", { message: BLOCKED_MESSAGE, ...after });
      else if (shown.trim()) {
        if (result?.cutOff) show(CUT_OFF_SUFFIX);
        send("done", after);
      } else send("error", { message: "The helper could not answer just now. Try again in a minute.", ...after });
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
