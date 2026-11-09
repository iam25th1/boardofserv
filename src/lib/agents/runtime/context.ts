import "server-only";
import { db } from "../../db";
import type { User } from "../../db/schema";
import { modelConfig, type JsonResult, type ModelConfig } from "../../model";
import { servKeyOf } from "../../servKey";
import { refusal } from "../../spend";
import { recordAgentCall, servOnly } from "../build";
import type { DecisionStepDef } from "../definition";
import type { Decided } from "../runner";
import type { WebPolicy } from "./webFetch";

export const DEFAULT_FETCHES_PER_DAY = 100;

type Env = Record<string, string | undefined>;

const whole = (raw: string | undefined, fallback: number) => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

export function fetchesPerDay(env: Env = process.env): number {
  return whole(env.AGENT_FETCHES_PER_DAY, DEFAULT_FETCHES_PER_DAY);
}

export const APP_URL = "https://boardofserv.25th.dev";

// The outside services owners connect and agents reach: Telegram, Google
// and Brave's web search. Every call goes through `fetch` (tests answer
// them). A service whose keys aren't set is off.
export interface Services {
  fetch: typeof fetch;
  telegramToken: string | null;
  google: { clientId: string; clientSecret: string; redirectUri: string } | null;
  braveKey: string | null;
  // Each installation's calls a day to Google Sheets and to web search,
  // and the whole site's searches a day.
  caps: { sheetCalls: number; searches: number; siteSearches: number };
}

export const DEFAULT_CAPS = { sheetCalls: 500, searches: 50, siteSearches: 1000 };

export function servicesFrom(env: Env = process.env): Services {
  const app = (env.APP_URL || APP_URL).replace(/\/+$/, "");
  return {
    fetch: (...args) => fetch(...args),
    telegramToken: env.TELEGRAM_BOT_TOKEN || null,
    google: env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, redirectUri: `${app}/api/connections/google/callback` } : null,
    braveKey: env.BRAVE_SEARCH_API_KEY || null,
    caps: {
      sheetCalls: whole(env.AGENT_SHEET_CALLS_PER_DAY, DEFAULT_CAPS.sheetCalls),
      searches: whole(env.AGENT_SEARCHES_PER_DAY, DEFAULT_CAPS.searches),
      siteSearches: whole(env.SITE_SEARCHES_PER_DAY, DEFAULT_CAPS.siteSearches),
    },
  };
}

// What the runtime works with: the database, the clock and SERV. The
// server's runtime uses the real ones; tests and the development demo pass
// their own (an in-memory Postgres, a clock they move, a stand-in for SERV).

export type Db = typeof db;

export interface Runtime {
  db: Db;
  now: () => Date;
  // SERV for an owner's decisions: on their own key when they have one.
  serv: (owner: User) => { config: ModelConfig; ownKey: boolean } | null;
  // Model calls go through this (tests answer them).
  fetchImpl?: typeof fetch;
  // Why the site may not spend on this owner now (the day's site limit).
  siteRefusal: (owner: User, ownKey: boolean) => Promise<string | null>;
  // One decision's model call, counted like any other.
  record: (owner: User, call: JsonResult, ownKey: boolean) => Promise<void>;
  // In place of SERV (the development demo only).
  decide?: (step: DecisionStepDef, input: Record<string, unknown>) => Promise<Decided>;
  // web.fetch's rules: never any exceptions on the server; tests and the
  // development demo let through a page they serve themselves.
  web: WebPolicy;
  // Pages an installation may fetch a day.
  fetchesPerDay: number;
  services: Services;
  log: (line: string) => void;
}

export function serverRuntime(): Runtime {
  return {
    db,
    now: () => new Date(),
    serv: (owner) => {
      const config = modelConfig(process.env, { servKey: servKeyOf(owner) });
      const serv = servOnly(config);
      return serv.providers.length ? { config: serv, ownKey: Boolean(config.ownKey) } : null;
    },
    siteRefusal: async (owner, ownKey) => (await refusal(owner.id, { ownKey }))?.error ?? null,
    record: (owner, call, ownKey) => recordAgentCall({ userId: owner.id, conversationId: null, ownKey }, "agent_decision", call),
    web: {},
    fetchesPerDay: fetchesPerDay(),
    services: servicesFrom(),
    log: (line) => console.info(line),
  };
}
