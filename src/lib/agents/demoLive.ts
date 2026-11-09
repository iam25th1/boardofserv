import "server-only";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { and, desc, eq, inArray } from "drizzle-orm";
import * as schema from "../db/schema";
import type { InstallationDTO, JobDTO, JobSummaryDTO } from "../types";
import type { AgentDefinition, DecisionStepDef } from "./definition";
import restock from "./examples/restock.json";
import { SUPPLIERS_HTML } from "./examples/supplierPage";
import type { Decided } from "./runner";
import { answer } from "./runtime/approvals";
import type { Runtime } from "./runtime/context";
import { control, install, installationDTO, loadInstallation, type Control } from "./runtime/installations";
import { jobFor, jobsOfInstallation } from "./runtime/views";
import { jobWorker } from "./runtime/worker";
import type { BenchData, StepCode } from "./types";

// /demo?agent=restock&live=1, development only: the example restock agent
// installed for a test owner and running for real, on the real runtime
// (installation, schedule, jobs, the worker, approvals that wait, web.fetch)
// in an in-memory Postgres inside the development server, so it needs no
// database and no keys. Every 90 seconds instead of every morning (and not
// while a job waits for an answer), against the stand-in sheets and the
// suppliers' price page this route serves itself. Decisions are made by a
// stand-in for SERV that follows the example's own rules, so no model is
// called. The route that imports this does so inside a development-only
// branch: a production build doesn't have it.

export const DEMO_EVERY_MS = 90_000;
const TICK_MS = 2_000;

interface Demo {
  rt: Runtime;
  ownerId: string;
  installationId: string;
  timer: ReturnType<typeof setInterval>;
}

const g = globalThis as unknown as { __bosDemoLive?: Promise<Demo> };

const definition = restock.definition as AgentDefinition;
const code = Object.fromEntries(Object.entries(restock.code).map(([k, c]) => [k, { ...c, spec: "", updatedAt: restock.builtAt } as StepCode]));

// The example's own rules, in place of SERV: ask over the owner's limit;
// go ahead on a yes.
async function standIn(step: DecisionStepDef, input: Record<string, unknown>): Promise<Decided> {
  const pick = (id: string, note: string): Decided => ({ ok: true, outcome: step.outcomes.some((o) => o.id === id) ? id : step.outcomes[0]!.id, note, costUsd: 0, model: "demo stand-in" });
  // "Do any orders exceed the approval limit?": each order line on its own.
  if (step.id === "check_approval") {
    const orders = (input.orders_to_place as { fabric?: string; total_cost_usdc?: number }[] | null) ?? [];
    const limit = Number((input.rules as { approval_limit?: number } | null)?.approval_limit ?? 0);
    const over = orders.filter((o) => Number(o.total_cost_usdc) > limit);
    return over.length
      ? pick("needs_approval", `${over.map((o) => `${o.fabric} (${o.total_cost_usdc} USDC)`).join(", ")} ${over.length === 1 ? "is" : "are"} over your limit of ${limit} USDC.`)
      : pick("no_approval_needed", `Every order is within your limit of ${limit} USDC.`);
  }
  if (step.id === "approval_decision") {
    const said = (input.approval_response as { answer?: string | null } | null)?.answer ?? null;
    return /^\s*yes/i.test(said ?? "") ? pick("approved", "You said yes.") : pick("declined", said === null ? "No answer came." : "You said no.");
  }
  return pick(step.outcomes[0]!.id, "The demo's stand-in took the first outcome.");
}

async function start(origin: string): Promise<Demo> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: join(process.cwd(), "src/lib/db/migrations") });
  const rt: Runtime = {
    db: db as unknown as Runtime["db"],
    now: () => new Date(),
    serv: () => null,
    siteRefusal: async () => null,
    record: async () => {},
    decide: standIn,
    web: { allowOrigins: [origin] },
    fetchesPerDay: 10_000,
    log: (line) => console.info(`demo: ${line}`),
  };
  const [owner] = await db.insert(schema.users).values({ privyUserId: "did:demo:shop", handle: "fabric_shop", access: "approved" }).returning();
  const [agent] = await db.insert(schema.agents).values({ ownerUserId: owner!.id, name: definition.name }).returning();
  const bench = restock.bench as BenchData;
  const [version] = await db
    .insert(schema.agentVersions)
    .values({ agentId: agent!.id, number: 1, state: "published", publishedAt: new Date(), definition, code, bench })
    .returning();
  const inst = await install(rt, {
    ownerUserId: owner!.id,
    agent: agent!,
    version: version!,
    answers: {
      settings: { ...bench.settings, suppliers_page: `${origin}/api/demo/agent/live?page=prices` },
      // Low enough that the linen order needs the owner's yes.
      rules: { approval_limit: "50" },
      timezone: "UTC",
      minGapMinutes: 0,
    },
  });
  const worker = jobWorker(rt);
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      // The schedule comes round every 90 seconds, not while a job is
      // still going or waiting for an answer.
      const live = await db
        .select({ id: schema.agentJobs.id })
        .from(schema.agentJobs)
        .where(and(eq(schema.agentJobs.installationId, inst.id), inArray(schema.agentJobs.status, ["queued", "running", "waiting_for_owner"])));
      const [last] = await db.select().from(schema.agentJobs).where(eq(schema.agentJobs.installationId, inst.id)).orderBy(desc(schema.agentJobs.createdAt)).limit(1);
      const due = new Date((last?.createdAt.getTime() ?? Date.now() - DEMO_EVERY_MS) + DEMO_EVERY_MS);
      await db
        .update(schema.agentTriggers)
        .set({ nextAt: live.length ? new Date(Date.now() + DEMO_EVERY_MS) : due })
        .where(eq(schema.agentTriggers.installationId, inst.id));
      await worker.cycle();
    } catch (err) {
      console.error(`demo: a cycle failed: ${err instanceof Error ? err.message : "unknown error"}`);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();
  void tick();
  return { rt, ownerId: owner!.id, installationId: inst.id, timer };
}

export function demoLive(origin: string): Promise<Demo> {
  g.__bosDemoLive ??= start(origin).catch((err: unknown) => {
    g.__bosDemoLive = undefined;
    throw err;
  });
  return g.__bosDemoLive;
}

export interface DemoState {
  installation: InstallationDTO;
  jobs: JobSummaryDTO[];
  job: JobDTO | null;
  everyMs: number;
}

export async function demoState(origin: string, jobId?: string | null): Promise<DemoState> {
  const d = await demoLive(origin);
  const loaded = (await loadInstallation(d.rt, d.installationId))!;
  const jobs = await jobsOfInstallation(d.rt, d.installationId, 8);
  const pick = jobId && jobs.some((j) => j.id === jobId) ? jobId : jobs[0]?.id;
  return { installation: await installationDTO(d.rt, loaded), jobs, job: pick ? await jobFor(d.rt, d.ownerId, pick) : null, everyMs: DEMO_EVERY_MS };
}

export async function demoAct(origin: string, body: { action: Control | "answer"; approvalId?: string; answer?: string }): Promise<void> {
  const d = await demoLive(origin);
  if (body.action === "answer") {
    await answer(d.rt, d.ownerId, body.approvalId ?? "", body.answer ?? "");
    return;
  }
  await control(d.rt, (await loadInstallation(d.rt, d.installationId))!, body.action);
}

export const demoPage = () => SUPPLIERS_HTML;
