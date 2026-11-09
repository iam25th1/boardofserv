// Runs the example restock agent as a real job, twice, with SERV making its
// decision for real: an in-memory database, the real runtime (schedule,
// worker, the spending guard and its approval, web.fetch, the sheet tools),
// a Google Sheet held in memory (Google's API answered here), and the
// suppliers' page served on 127.0.0.1 by this script. The owner's limit is
// 50 USDC, so the order's total waits for an answer: "Yes" the first time,
// "No" the second. With TELEGRAM_BOT_TOKEN and LIVE_TELEGRAM_CHAT (an owner's
// chat with the bot) set, the question really goes to that chat with its
// buttons, and the message is edited to show the answer given here. It
// prints each job's steps and every SERV and Telegram call with its status
// and time, never a key, and stops before more than LIVE_SERV_BUDGET SERV
// calls or LIVE_TELEGRAM_BUDGET Telegram calls.
//
//   SERV_API_KEY=... npx vite-node --config vitest.config.ts scripts/live-restock.ts

import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { asc, eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { servOnly } from "@/lib/agents/build";
import type { AgentDefinition } from "@/lib/agents/definition";
import restock from "@/lib/agents/examples/restock.json";
import { SUPPLIERS_HTML } from "@/lib/agents/examples/supplierPage";
import { answer, approvalsOf } from "@/lib/agents/runtime/approvals";
import { keep } from "@/lib/connections/vault";
import { MemorySheets } from "@/lib/google/memorySheets";
import { DEFAULT_CAPS, type Runtime } from "@/lib/agents/runtime/context";
import { install } from "@/lib/agents/runtime/installations";
import { jobWorker } from "@/lib/agents/runtime/worker";
import type { BenchData, StepCode } from "@/lib/agents/types";
import { modelConfig } from "@/lib/model";

const BUDGET = Number(process.env.LIVE_SERV_BUDGET ?? 6);
const TG_BUDGET = Number(process.env.LIVE_TELEGRAM_BUDGET ?? 6);
const CHAT = Number(process.env.LIVE_TELEGRAM_CHAT ?? 0);
const calls: { status: number; ms: number; promptTokens: number | null; completionTokens: number | null }[] = [];
const tgCalls: { method: string; status: number; ms: number }[] = [];
const realFetch = globalThis.fetch;
const SHEET_ID = "LiveFabricShopSheet000000000000";
const sheets = new MemorySheets();

// The runtime's outside calls: Google answered here, Telegram for real
// (counted) when a chat is given, nothing else.
const services = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.host === "sheets.googleapis.com") return sheets.answer(url, (init?.method ?? "GET").toUpperCase(), init?.body ? String(init.body) : null);
  if (url.href === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "live-access", expires_in: 3600 });
  if (url.host === "api.telegram.org" && CHAT) {
    if (tgCalls.length >= TG_BUDGET) throw new Error(`live: the Telegram budget of ${TG_BUDGET} calls is used up`);
    const started = Date.now();
    const res = await realFetch(input, init);
    tgCalls.push({ method: url.pathname.split("/").pop()!, status: res.status, ms: Date.now() - started });
    return res;
  }
  if (url.origin.startsWith("http://127.0.0.1")) return realFetch(input, init);
  throw new Error(`live: refused a call to ${url.host}`);
}) as typeof fetch;
const counted = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (!String(input).includes("inference-api.openserv.ai")) throw new Error("live: refused a call that isn't SERV");
  if (calls.length >= BUDGET) throw new Error(`live: the SERV budget of ${BUDGET} calls is used up`);
  const started = Date.now();
  const res = await realFetch(input, init);
  const body = (await res.clone().json().catch(() => null)) as { usage?: { prompt_tokens?: number; completion_tokens?: number } } | null;
  calls.push({ status: res.status, ms: Date.now() - started, promptTokens: body?.usage?.prompt_tokens ?? null, completionTokens: body?.usage?.completion_tokens ?? null });
  return res;
}) as typeof fetch;

async function main() {
  const serv = servOnly(modelConfig(process.env));
  if (!serv.providers.length) throw new Error("live: SERV_API_KEY must be set");
  const server = createServer((req, res) => (req.url === "/prices" ? res.writeHead(200, { "content-type": "text/html" }).end(SUPPLIERS_HTML) : res.writeHead(404).end()));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: join(process.cwd(), "src/lib/db/migrations") });
  const rt: Runtime = {
    db: db as unknown as Runtime["db"],
    now: () => new Date(),
    serv: () => ({ config: serv, ownKey: false }),
    fetchImpl: counted,
    siteRefusal: async () => null,
    record: async () => {},
    web: { allowOrigins: [origin] },
    fetchesPerDay: 100,
    services: { fetch: services, telegramToken: CHAT ? (process.env.TELEGRAM_BOT_TOKEN ?? null) : null, google: { clientId: "live", clientSecret: "live", redirectUri: "http://127.0.0.1/callback" }, braveKey: null,
    reppo: null, caps: DEFAULT_CAPS },
    log: (line) => console.log(line),
  };
  const [owner] = await db.insert(schema.users).values({ privyUserId: "did:live:shop", handle: "fabric_shop", access: "approved" }).returning();
  // The owner's connections, kept encrypted (with a key for this run only
  // when none is set): their Telegram chat, if given, and Google.
  process.env.OPENSERV_KEY_ENC_KEY ||= randomBytes(32).toString("base64");
  await keep(rt, owner!.id, "telegram", CHAT ? "the given chat" : "none", { chatId: CHAT, userId: CHAT });
  await keep(rt, owner!.id, "google", "live run", { refreshToken: "live", accessToken: "live-access", expiresAt: Date.now() + 3_600_000, scope: "https://www.googleapis.com/auth/spreadsheets" });
  sheets.add(SHEET_ID, "Fabric shop (live run)", { Stock: (restock.bench as BenchData).sheets.Stock ?? [], Orders: [] });
  const tab = (t: string) => ({ url: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`, tab: t });
  const definition = restock.definition as AgentDefinition;
  const code = Object.fromEntries(Object.entries(restock.code).map(([k, c]) => [k, { ...c, spec: "", updatedAt: "" } as StepCode]));
  const [agent] = await db.insert(schema.agents).values({ ownerUserId: owner!.id, name: definition.name }).returning();
  const [version] = await db.insert(schema.agentVersions).values({ agentId: agent!.id, number: 1, state: "published", publishedAt: new Date(), definition, code, bench: restock.bench as BenchData }).returning();
  const inst = await install(rt, {
    ownerUserId: owner!.id,
    agent: agent!,
    version: version!,
    answers: {
      settings: { ...(restock.bench as BenchData).settings, stock_sheet: tab("Stock"), orders_sheet: tab("Orders"), suppliers_page: `${origin}/prices` },
      rules: { approval_limit: "50" },
      timezone: "UTC",
      minGapMinutes: 0,
    },
  });
  const worker = jobWorker(rt);
  const settle = async () => {
    await worker.cycle();
    await Promise.all(worker.running());
  };
  for (const said of ["Yes", "No"]) {
    await db.update(schema.agentTriggers).set({ nextAt: new Date() }).where(eq(schema.agentTriggers.installationId, inst.id));
    await settle();
    const [ask] = await approvalsOf(rt, owner!.id, { pendingOnly: true });
    if (ask) {
      console.log(`\nAsked: ${ask.question.split("\n")[0]}... answering "${said}"`);
      await answer(rt, owner!.id, ask.id, said);
      await settle();
    }
    const [job] = await db.select().from(schema.agentJobs).where(eq(schema.agentJobs.installationId, inst.id)).orderBy(asc(schema.agentJobs.createdAt)).offset(said === "Yes" ? 0 : 1).limit(1);
    console.log(`Job: ${job!.status}: ${job!.reason} ($${Number(job!.costUsd).toFixed(6)})`);
    for (const s of await db.select().from(schema.agentJobSteps).where(eq(schema.agentJobSteps.jobId, job!.id)).orderBy(asc(schema.agentJobSteps.seq))) {
      console.log(`  ${s.stepId.padEnd(26)} ${s.status.padEnd(7)} ${String(s.ms).padStart(5)} ms ${s.model ?? ""} ${s.outcome ? `-> ${s.outcome}` : ""} ${s.note && s.status !== "waiting" ? `(${s.note.slice(0, 90)})` : ""}`);
    }
  }
  const [row] = await db.select().from(schema.agentInstallations).where(eq(schema.agentInstallations.id, inst.id));
  console.log(`\nOrders recorded in the sheet: ${sheets.rows(SHEET_ID, "Orders").length}; remembered: ${JSON.stringify(Object.keys(row!.memory))}`);
  worker.stop();
  server.close();
  await client.close();
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : "live run failed");
    process.exitCode = 1;
  })
  .finally(() => {
    console.log("\nSERV calls:");
    for (const c of calls) console.log(`  decision ${c.status} ${String(c.ms).padStart(6)} ms  in ${c.promptTokens ?? "?"}  out ${c.completionTokens ?? "?"}`);
    console.log(`  ${calls.length} of ${BUDGET}`);
    if (CHAT) {
      console.log("Telegram calls:");
      for (const c of tgCalls) console.log(`  ${c.method.padEnd(16)} ${c.status} ${String(c.ms).padStart(6)} ms`);
      console.log(`  ${tgCalls.length} of ${TG_BUDGET}`);
    }
  });
