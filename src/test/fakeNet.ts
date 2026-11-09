import { MemorySheets } from "@/lib/google/memorySheets";

// The outside services (Telegram, Google, Brave) as tests see them: every
// request is kept, and answered by the first handler whose pattern matches
// its address, newest handler first. Telegram's methods answer ok by
// default, with message ids counting up; anything else unhandled is a 404.

export interface NetRequest {
  url: URL;
  method: string;
  headers: Headers;
  body: string | null;
  // Telegram's method ("sendMessage"), when it is a Telegram call.
  method_?: string;
  json: () => Record<string, unknown>;
}

export interface FakeNet {
  fetch: typeof fetch;
  calls: NetRequest[];
  on(pattern: string | RegExp, handler: (req: NetRequest) => Response | Promise<Response>): void;
  // The Telegram calls made, by method.
  telegram(method?: string): Record<string, unknown>[];
  // Google Sheets: spreadsheets by id, each with its tabs' cells.
  sheets: MemorySheets["books"];
  // A spreadsheet made of tabs of records (the first row names the columns).
  addSheet(id: string, title: string, tabs: Record<string, Record<string, unknown>[]>): string;
  // A tab's rows, as records.
  rows(id: string, tab: string): Record<string, unknown>[];
}

export const fakeSheetId = (name: string) => `${name.replace(/[^A-Za-z0-9]/g, "")}SheetId0123456789abcdef`.slice(0, 40);
export const fakeSheetUrl = (id: string, gid = 0) => `https://docs.google.com/spreadsheets/d/${id}/edit#gid=${gid}`;

export const TEST_BOT_TOKEN = "123456:test-bot-token";

export function fakeNet(): FakeNet {
  const handlers: { pattern: string | RegExp; handler: (req: NetRequest) => Response | Promise<Response> }[] = [];
  const calls: NetRequest[] = [];
  let messageId = 100;
  let tokens = 0;
  const memory = new MemorySheets();
  const net: FakeNet = {
    calls,
    sheets: memory.books,
    addSheet: (id, title, tabs) => memory.add(id, title, tabs),
    rows: (id, tab) => memory.rows(id, tab),
    on(pattern, handler) {
      handlers.unshift({ pattern, handler });
    },
    telegram(method) {
      return calls.filter((c) => c.url.host === "api.telegram.org" && (!method || c.method_ === method)).map((c) => c.json());
    },
    fetch: (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const body = init.body === undefined || init.body === null ? null : String(init.body);
      const req: NetRequest = {
        url,
        method: (init.method ?? "GET").toUpperCase(),
        headers: new Headers(init.headers),
        body,
        method_: url.host === "api.telegram.org" ? url.pathname.split("/").pop() : undefined,
        json: () => {
          if (!body) return {};
          try {
            return JSON.parse(body) as Record<string, unknown>;
          } catch {
            return Object.fromEntries(new URLSearchParams(body));
          }
        },
      };
      calls.push(req);
      const found = handlers.find((h) => (typeof h.pattern === "string" ? url.href.startsWith(h.pattern) : h.pattern.test(url.href)));
      if (found) return found.handler(req);
      if (url.host === "sheets.googleapis.com") return memory.answer(url, req.method, body);
      if (url.href === "https://oauth2.googleapis.com/token") {
        tokens += 1;
        return Response.json({ access_token: `fresh-access-${tokens}`, expires_in: 3600, scope: "https://www.googleapis.com/auth/spreadsheets", token_type: "Bearer" });
      }
      if (req.method_) {
        messageId += 1;
        const sent = { message_id: messageId, date: 0, chat: { id: (req.json().chat_id as number) ?? 0, type: "private" } };
        return Response.json({ ok: true, result: req.method_ === "answerCallbackQuery" ? true : sent });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch,
  };
  return net;
}
