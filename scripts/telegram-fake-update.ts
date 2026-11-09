// Development only: posts a made-up Telegram update to a local server's
// webhook, the way Telegram would, with the development secret
// (TELEGRAM_DEV_WEBHOOK_SECRET, which the local server must have too). It
// never talks to Telegram and never changes the live bot's webhook.
//
//   npx vite-node --config vitest.config.ts scripts/telegram-fake-update.ts -- start CODE
//   npx vite-node --config vitest.config.ts scripts/telegram-fake-update.ts -- text "Check the stock now"
//   npx vite-node --config vitest.config.ts scripts/telegram-fake-update.ts -- press a:<approval id>:0
//
// Options: --to http://localhost:3001 (the default), --chat 4242 (the
// made-up chat and user id).

import { randomInt } from "node:crypto";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args.splice(i, 2)[1]! : fallback;
};
const to = opt("--to", "http://localhost:3001");
const chat = Number(opt("--chat", "4242"));
const [what, value = ""] = args.filter((a) => a !== "--");

async function main() {
  const host = new URL(to).hostname;
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) throw new Error("It only posts to a server on this computer.");
  const secret = process.env.TELEGRAM_DEV_WEBHOOK_SECRET;
  if (!secret) throw new Error("Set TELEGRAM_DEV_WEBHOOK_SECRET, here and for the local server.");
  const from = { id: chat, is_bot: false, first_name: "Local", username: "local_owner" };
  const message = (text: string) => ({ message_id: randomInt(1, 1e6), from, chat: { id: chat, type: "private" }, date: Math.floor(Date.now() / 1000), text });
  const update =
    what === "start"
      ? { message: message(`/start ${value}`) }
      : what === "text"
        ? { message: message(value) }
        : what === "press"
          ? { callback_query: { id: String(randomInt(1, 1e9)), from, message: message("(the question)"), data: value } }
          : null;
  if (!update) throw new Error('Say start CODE, text "...", or press DATA.');
  const res = await fetch(`${to}/api/telegram/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
    body: JSON.stringify({ update_id: randomInt(1, 2 ** 31), ...update }),
  });
  console.log(`${res.status} ${await res.text()}`);
}

main().catch((err: unknown) => {
  console.error(`telegram-fake-update: ${err instanceof Error ? err.message : "failed"}`);
  process.exit(1);
});
