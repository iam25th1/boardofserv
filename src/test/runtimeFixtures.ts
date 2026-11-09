import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "@/lib/db/schema";
import { modelConfig } from "@/lib/model";
import { servOnly } from "@/lib/agents/build";
import { checkDefinition, type AgentDefinition } from "@/lib/agents/definition";
import { wireToDefinition } from "@/lib/agents/plan";
import type { Runtime } from "@/lib/agents/runtime/context";
import { install } from "@/lib/agents/runtime/installations";
import type { InstallAnswers } from "@/lib/agents/settingsForm";
import type { BenchData, StepCode } from "@/lib/agents/types";
import { COMPARE, FIND_LOW, RESTOCK_WIRE, restockBench } from "./agentFixtures";

// The runtime on an in-memory Postgres: a clock the test moves, SERV
// answered by the test (each decision's outcome from `decisions`, by step),
// and every log line kept.

export interface TestRuntime extends Runtime {
  clock: { at: Date; move(ms: number): void };
  logged: string[];
  // What SERV was asked, each decision.
  asked: string[];
  // The outcome SERV picks from the ones offered ("" for no answer at all).
  serve: (outcomes: string[], content: string) => string;
}

export function testRuntime(db: PgliteDatabase<typeof schema>, start = new Date("2026-11-09T06:00:00Z")): TestRuntime {
  const clock = {
    at: start,
    move(ms: number) {
      this.at = new Date(this.at.getTime() + ms);
    },
  };
  const rt: TestRuntime = {
    db: db as unknown as Runtime["db"],
    now: () => clock.at,
    clock,
    logged: [],
    asked: [],
    serve: (ids) => ids[0]!,
    serv: () => ({ config: servOnly(modelConfig({ SERV_API_KEY: "test-serv" })), ownKey: false }),
    siteRefusal: async () => null,
    record: async () => {},
    web: {},
    fetchesPerDay: 100,
    log: (line) => void rt.logged.push(line),
    fetchImpl: (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: { content: string }[]; response_format: { json_schema: { schema: { properties: { outcome: { enum: string[] } } } } } };
      const ids = body.response_format.json_schema.schema.properties.outcome.enum;
      rt.asked.push(body.messages[1]!.content);
      const outcome = rt.serve(ids, body.messages[1]!.content);
      if (outcome === "") return new Response("{}", { status: 503 });
      return Response.json({ choices: [{ message: { content: JSON.stringify({ outcome, reason: "Because." }) } }], usage: { prompt_tokens: 400, completion_tokens: 20 } });
    }) as typeof fetch,
  };
  return rt;
}

export const restockDefinition = (): AgentDefinition => {
  const c = checkDefinition(wireToDefinition(RESTOCK_WIRE));
  if (!c.ok) throw new Error(c.errors.join("; "));
  return c.definition;
};

const ok = (source: string): StepCode => ({ spec: "", status: "approved", source, rounds: 1, note: null, updatedAt: "" });
export const RESTOCK_CODE = { find_low: ok(FIND_LOW), compare: ok(COMPARE) };

// A maker's agent with one published version.
export async function publishedAgent(
  db: PgliteDatabase<typeof schema>,
  maker: schema.User,
  o: { definition?: AgentDefinition; code?: Record<string, StepCode>; bench?: BenchData } = {},
): Promise<{ agent: schema.Agent; version: schema.AgentVersion }> {
  const definition = o.definition ?? restockDefinition();
  const [agent] = await db.insert(schema.agents).values({ ownerUserId: maker.id, name: definition.name }).returning();
  const [version] = await db
    .insert(schema.agentVersions)
    .values({ agentId: agent!.id, number: 1, state: "published", publishedAt: new Date(), definition, code: o.code ?? RESTOCK_CODE, bench: o.bench ?? restockBench() })
    .returning();
  return { agent: agent!, version: version! };
}

export async function installed(
  rt: Runtime,
  owner: schema.User,
  p: { agent: schema.Agent; version: schema.AgentVersion },
  answers: Partial<InstallAnswers> = {},
): Promise<schema.AgentInstallation> {
  return install(rt, {
    ownerUserId: owner.id,
    agent: p.agent,
    version: p.version,
    answers: { settings: { stock_sheet: "Stock", orders_sheet: "Orders" }, rules: {}, timezone: "UTC", minGapMinutes: 0, ...answers },
  });
}
