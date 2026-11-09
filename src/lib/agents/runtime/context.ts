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

export function fetchesPerDay(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.AGENT_FETCHES_PER_DAY);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_FETCHES_PER_DAY;
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
    log: (line) => console.info(line),
  };
}
