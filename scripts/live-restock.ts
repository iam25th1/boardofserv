// Runs the example restock agent as a real job, once, with SERV making its
// decisions for real: an in-memory database, the real runtime (schedule,
// worker, approval, web.fetch), stand-in sheets, and the suppliers' page
// served on 127.0.0.1 by this script. The owner's limit is 50 USDC, so the
// order waits for an answer: "Yes" the first time, "No" the second. It
// prints each job's steps and every model call with its status, tokens and
// time, never a key, and stops before more than LIVE_SERV_BUDGET calls.
//
//   SERV_API_KEY=... npx vite-node --config vitest.config.ts scripts/live-restock.ts

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
import type { Runtime } from "@/lib/agents/runtime/context";
import { install } from "@/lib/agents/runtime/installations";
import { jobWorker } from "@/lib/agents/runtime/worker";
import type { BenchData, StepCode } from "@/lib/agents/types";
import { modelConfig } from "@/lib/model";

const BUDGET = Number(process.env.LIVE_SERV_BUDGET ?? 6);
const calls: { status: number; ms: number; promptTokens: number | null; completionTokens: number | null }[] = [];
const realFetch = globalThis.fetch;
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
    log: (line) => console.log(line),
  };
  const [owner] = await db.insert(schema.users).values({ privyUserId: "did:live:shop", handle: "fabric_shop", access: "approved" }).returning();
  const definition = restock.definition as AgentDefinition;
  const code = Object.fromEntries(Object.entries(restock.code).map(([k, c]) => [k, { ...c, spec: "", updatedAt: "" } as StepCode]));
  const [agent] = await db.insert(schema.agents).values({ ownerUserId: owner!.id, name: definition.name }).returning();
  const [version] = await db.insert(schema.agentVersions).values({ agentId: agent!.id, number: 1, state: "published", publishedAt: new Date(), definition, code, bench: restock.bench as BenchData }).returning();
  const inst = await install(rt, {
    ownerUserId: owner!.id,
    agent: agent!,
    version: version!,
    answers: { settings: { ...(restock.bench as BenchData).settings, suppliers_page: `${origin}/prices` }, rules: { approval_limit: "50" }, timezone: "UTC", minGapMinutes: 0 },
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
  console.log(`\nOrders recorded: ${row!.mocks.sheets.Orders?.length ?? 0}; remembered: ${JSON.stringify(Object.keys(row!.memory))}`);
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
  });
