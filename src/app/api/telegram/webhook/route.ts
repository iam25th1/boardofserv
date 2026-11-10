import { serverRuntime } from "@/lib/agents/runtime/context";
import type { TgUpdate } from "@/lib/telegram/api";
import { SECRET_HEADER, webhookSecretOk } from "@/lib/telegram/link";
import { handleUpdate } from "@/lib/telegram/updates";
import { rateLimited } from "@/lib/rateLimit";

export const runtime = "nodejs";

const MAX_BYTES = 256 * 1024;

// Telegram's webhook. Only a request carrying the secret set with the
// webhook (in X-Telegram-Bot-Api-Secret-Token) is read; anything else is
// refused before its body is looked at.
export async function POST(req: Request) {
  const limited = rateLimited(req, "webhook");
  if (limited) return limited;
  const rt = serverRuntime();
  if (!rt.services.telegramToken || !(await webhookSecretOk(rt, req.headers.get(SECRET_HEADER)))) return Response.json({ error: "Not allowed" }, { status: 401 });
  const raw = await req.text();
  if (raw.length > MAX_BYTES) return Response.json({ error: "Too large" }, { status: 413 });
  let update: TgUpdate;
  try {
    update = JSON.parse(raw) as TgUpdate;
  } catch {
    return Response.json({ error: "Not JSON" }, { status: 400 });
  }
  if (!update || typeof update !== "object" || typeof update.update_id !== "number") return Response.json({ ok: true });
  try {
    await handleUpdate(rt, update);
  } catch (err) {
    // Telegram sends it again later.
    rt.log(`telegram: an update wasn't handled: ${err instanceof Error ? err.name : "unknown error"}`);
    return Response.json({ error: "Try again" }, { status: 500 });
  }
  return Response.json({ ok: true });
}
