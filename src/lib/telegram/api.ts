import "server-only";
import type { Services } from "../agents/runtime/context";

// Telegram's Bot API (core.telegram.org/bots/api): one HTTPS call per
// method, the bot's token in the path. The token never leaves this module:
// errors carry Telegram's own description and status, never the address.
//
// Limits from Telegram's FAQ: about one message a second in a chat and
// thirty a second in all; past them it answers 429 with retry_after, the
// seconds to wait.

export class TelegramError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    // Seconds Telegram asks to wait (429), when it says.
    readonly retryAfter: number | null = null,
  ) {
    super(message);
    this.name = "TelegramError";
  }
}

const TIMEOUT_MS = 10_000;

export async function tg<T = unknown>(services: Services, method: string, body: Record<string, unknown> = {}): Promise<T> {
  if (!services.telegramToken) throw new TelegramError("Telegram isn't set up here.", null);
  let res: Response;
  try {
    res = await services.fetch(`https://api.telegram.org/bot${services.telegramToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new TelegramError(`Telegram couldn't be reached (${method}).`, null);
  }
  const data = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; description?: string; parameters?: { retry_after?: number } } | null;
  if (!res.ok || !data?.ok) {
    const description = typeof data?.description === "string" ? data.description.slice(0, 200) : `status ${res.status}`;
    throw new TelegramError(`Telegram refused ${method}: ${description}`, res.status, data?.parameters?.retry_after ?? null);
  }
  return data.result as T;
}

// The bot's username, asked once per process.
const usernames = new Map<string, Promise<string>>();
export function botUsername(services: Services): Promise<string> {
  const key = services.telegramToken ?? "";
  let name = usernames.get(key);
  if (!name) {
    name = tg<{ username: string }>(services, "getMe").then((me) => me.username);
    name.catch(() => usernames.delete(key));
    usernames.set(key, name);
  }
  return name;
}

// What Telegram sends the webhook (the parts boardofserv reads).
export interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}

export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: { id: number; type: string };
  text?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: { id: string; from: TgUser; message?: TgMessage; data?: string };
}

export type InlineKeyboard = { text: string; callback_data: string }[][];

// Telegram's limit on a message's text.
export const MAX_TEXT = 4096;
export const clip = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 3)}...` : text);
