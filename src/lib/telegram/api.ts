import "server-only";
import type { Services } from "../agents/runtime/context";
import { plainText, telegramHtml } from "./format";

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

// A message too long for one, in parts Telegram takes one at a time (with
// room for its HTML): each ends where a line does, or, for a line longer
// than a part, at a space. Nothing is cut: the parts, a new line between
// them (a space within a long line), are the whole text.
export const PART_TEXT = 3500;

// The parts as they go: each numbered, "(2/4)" on a line of its own at its
// end, when there is more than one.
export function numberedParts(text: string, max = PART_TEXT): string[] {
  const parts = inParts(text, max);
  return parts.length === 1 ? parts : parts.map((p, i) => `${p}\n(${i + 1}/${parts.length})`);
}
export function inParts(text: string, max = PART_TEXT): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let lines: string[] = [];
  let size = 0;
  const flush = () => {
    if (lines.length) parts.push(lines.join("\n"));
    lines = [];
    size = 0;
  };
  const add = (line: string) => {
    if (lines.length && size + 1 + line.length > max) flush();
    size += (lines.length ? 1 : 0) + line.length;
    lines.push(line);
  };
  for (const line of text.split("\n")) {
    if (line.length <= max) {
      add(line);
      continue;
    }
    flush();
    let rest = line;
    while (rest.length > max) {
      const at = rest.lastIndexOf(" ", max);
      parts.push(rest.slice(0, at > 0 ? at : max));
      rest = rest.slice(at > 0 ? at + 1 : max);
    }
    add(rest);
  }
  flush();
  return parts;
}

// A message's text as Telegram shows it best: its HTML, with plain text
// to fall back on when Telegram can't read the HTML.
export function textFields(text: string): { text: string; parse_mode: "HTML" } {
  return { text: telegramHtml(clip(text)), parse_mode: "HTML" };
}

// Sends (or edits) a message with its text as HTML; when Telegram can't
// parse it, the same message goes again as plain text with no marks.
export async function sendText<T = unknown>(services: Services, method: "sendMessage" | "editMessageText", body: Record<string, unknown> & { text: string }): Promise<T> {
  try {
    return await tg<T>(services, method, { ...body, ...textFields(body.text) });
  } catch (err) {
    if (!(err instanceof TelegramError) || err.status !== 400 || !/parse entities|can't find end|unsupported start tag/i.test(err.message)) throw err;
    return tg<T>(services, method, { ...body, text: clip(plainText(body.text)) });
  }
}

