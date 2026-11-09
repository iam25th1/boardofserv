import { randomBytes } from "node:crypto";
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
import { hasConnection, keep } from "@/lib/connections/vault";
import { resetSheetLimits } from "@/lib/google/sheets";
import { COMPARE, FIND_LOW, RESTOCK_WIRE, restockBench } from "./agentFixtures";
import { fakeNet, fakeSheetUrl, TEST_BOT_TOKEN, type FakeNet } from "./fakeNet";

// Connection secrets are encrypted like every other stored secret.
process.env.OPENSERV_KEY_ENC_KEY ||= randomBytes(32).toString("base64");

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
  // Telegram, Google and Brave, answered by the test.
  net: FakeNet;
}

export function testRuntime(db: PgliteDatabase<typeof schema>, start = new Date("2026-11-09T06:00:00Z")): TestRuntime {
  const clock = {
    at: start,
    move(ms: number) {
      this.at = new Date(this.at.getTime() + ms);
    },
  };
  const net = fakeNet();
  resetSheetLimits();
  const rt: TestRuntime = {
    db: db as unknown as Runtime["db"],
    net,
    services: {
      fetch: net.fetch,
      telegramToken: TEST_BOT_TOKEN,
      google: { clientId: "test-client", clientSecret: "test-google-secret", redirectUri: "https://boardofserv.test/api/connections/google/callback" },
      braveKey: "test-brave-key",
      caps: { sheetCalls: 500, searches: 50, siteSearches: 1000 },
    },
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

// The owner's Telegram chat and Google account, as if they had linked
// them. Each owner's chat is their own unless the test names one.
export const TEST_CHAT_ID = 4242;
const chatOf = (owner: schema.User) => 100_000 + (parseInt(owner.id.replace(/-/g, "").slice(0, 7), 16) % 900_000);
export async function linkConnections(rt: Runtime, owner: schema.User, chatId = chatOf(owner)): Promise<void> {
  await keep(rt, owner.id, "telegram", "@owner", { chatId, userId: chatId });
  await keep(rt, owner.id, "google", "owner@example.com", { refreshToken: `refresh-${owner.id}`, accessToken: `access-${owner.id}`, expiresAt: rt.now().getTime() + 3_600_000, scope: "spreadsheets" });
}

let sheetCount = 0;

// The owner's own Google Sheet with the bench's tabs, served by the fake
// Google: its link and tab for each sheet setting.
export function ownSheet(rt: TestRuntime, tabs: Record<string, Record<string, unknown>[]> = restockBench().sheets): { id: string; answer: (tab: string) => { url: string; tab: string } } {
  sheetCount += 1;
  const id = `TestSheet${String(sheetCount).padStart(4, "0")}abcdefghijklmnopqrstuv`;
  rt.net.addSheet(id, `Fabric shop ${sheetCount}`, tabs);
  return { id, answer: (tab) => ({ url: fakeSheetUrl(id), tab }) };
}

// A tab's rows in the owner's sheet, for an installation's sheet setting.
export function sheetRows(rt: TestRuntime, inst: schema.AgentInstallation, key: string): Record<string, unknown>[] {
  const g = inst.sheets[key]!;
  return rt.net.rows(g.spreadsheetId, g.tab);
}

export async function installed(
  rt: Runtime,
  owner: schema.User,
  p: { agent: schema.Agent; version: schema.AgentVersion },
  answers: Partial<InstallAnswers> = {},
  o: { telegram?: boolean } = {},
): Promise<schema.AgentInstallation> {
  if (!(await hasConnection(rt, owner.id, "google"))) await keep(rt, owner.id, "google", "owner@example.com", { refreshToken: `refresh-${owner.id}`, accessToken: `access-${owner.id}`, expiresAt: rt.now().getTime() + 3_600_000, scope: "spreadsheets" });
  if (o.telegram !== false && !(await hasConnection(rt, owner.id, "telegram"))) await keep(rt, owner.id, "telegram", "@owner", { chatId: chatOf(owner), userId: chatOf(owner) });
  const sheet = ownSheet(rt as TestRuntime);
  return install(rt, {
    ownerUserId: owner.id,
    agent: p.agent,
    version: p.version,
    answers: {
      settings: { stock_sheet: sheet.answer("Stock"), orders_sheet: sheet.answer("Orders"), suppliers_sheet: sheet.answer("Suppliers") },
      rules: {},
      timezone: "UTC",
      minGapMinutes: 0,
      ...answers,
    },
  });
}
