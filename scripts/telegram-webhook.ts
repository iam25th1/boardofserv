// Points the live bot's webhook at boardofserv, with a fresh secret. The
// owner runs it once after deploying (and again any time to change the
// secret). The secret goes to Telegram and, as a hash only, to the
// database the server checks it against; it is never printed. What prints
// is Telegram's answer and the webhook's address.
//
// Without --apply it only shows the webhook as it is now (getWebhookInfo)
// and changes nothing.
//
//   npx vite-node --config vitest.config.ts scripts/telegram-webhook.ts -- --env-file <file> [--apply]
//
// It needs TELEGRAM_BOT_TOKEN, DATABASE_URL and APP_URL (default
// https://boardofserv.25th.dev), from --env-file or the environment.

import { db } from "@/lib/db";
import { servicesFrom, type Runtime } from "@/lib/agents/runtime/context";
import { tg } from "@/lib/telegram/api";
import { newWebhookSecret, restoreWebhookSecret, storeWebhookSecret } from "@/lib/telegram/link";

const args = process.argv.slice(2);
const envFile = args[args.indexOf("--env-file") + 1];
if (args.includes("--env-file") && envFile) process.loadEnvFile(envFile);
const apply = args.includes("--apply");

async function main() {
  const services = servicesFrom(process.env);
  if (!services.telegramToken) throw new Error("TELEGRAM_BOT_TOKEN is not set.");
  const url = `${(process.env.APP_URL || "https://boardofserv.25th.dev").replace(/\/+$/, "")}/api/telegram/webhook`;
  const info = await tg<{ url: string; pending_update_count: number; last_error_message?: string }>(services, "getWebhookInfo");
  console.log(`Now: ${info.url ? `webhook at ${info.url}` : "no webhook"}, ${info.pending_update_count} updates waiting${info.last_error_message ? `, last error: ${info.last_error_message}` : ""}.`);
  if (!apply) {
    console.log(`Would set it to ${url} with a fresh secret. Run again with --apply to do it.`);
    return;
  }
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set.");
  const rt = { db, now: () => new Date(), services, log: () => {} } as unknown as Runtime;
  const secret = newWebhookSecret();
  // The server takes the new secret (and the old one, for a few minutes)
  // before Telegram starts sending it.
  await storeWebhookSecret(rt, secret);
  try {
    const ok = await tg<boolean>(services, "setWebhook", { url, secret_token: secret, allowed_updates: ["message", "callback_query"], max_connections: 10 });
    console.log(`Set: ${ok ? "Telegram took it" : "Telegram said no"}, webhook at ${url}.`);
  } catch (err) {
    await restoreWebhookSecret(rt);
    throw err;
  }
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(`telegram-webhook: ${err instanceof Error ? err.message : "failed"}`);
    process.exit(1);
  },
);
