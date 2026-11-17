// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "@/lib/db/schema";
import { keep } from "@/lib/connections/vault";
import { modelPrices } from "@/lib/model";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { claimJob, runJob } from "@/lib/agents/runtime/jobs";
import { install } from "@/lib/agents/runtime/installations";
import { upgradeRecipeAgents } from "@/lib/agents/recipes/upgrade";
import { NOT_SEEN } from "@/lib/agents/recipes/watch";
import type { AgentDefinition } from "@/lib/agents/definition";
import type { StepCode } from "@/lib/agents/types";
import type { InstallationDTO } from "@/lib/types";
import { addUser, testDb } from "./helperDb";
import { Ledger } from "./suite/live";
import v1 from "./fixtures/watchRecipeV1.json";

// The GitHub judge, live: a copy of an owner's GitHub Code Verifier as it
// was built (version 1, from the watch recipe before revision 2) is moved
// to the new judge the way an owner moves it: the worker's upgrade makes
// version 2, the copy's page offers it, Switch (the real route) moves the
// copy, and Check the latest 5 again (the real route) runs it once over
// the latest five commits of iam25th1/boardofserv, read from GitHub's
// public API, each judged by SERV on the site's key. The message is
// checked: no finding about cut or missing content, the merge skipped, the
// counts those of the verdicts. An in-memory database; nothing is sent.
//
// JUDGE_COPY names a JSON file with a copy of the verifier ({ definition,
// code, settings, memory, timezone }), kept out of the repository; without
// it, the recipe's own version 1 (fixtures/watchRecipeV1.json). Off unless
// RUN_JUDGE_LIVE=1 with SERV_API_KEY. JUDGE_REPORT keeps what happened.
//
//   RUN_JUDGE_LIVE=1 JUDGE_REPORT=judge.json npx vitest run src/test/judge-live.test.ts

process.env.OPENSERV_KEY_ENC_KEY ||= randomBytes(32).toString("base64");

const enabled = process.env.RUN_JUDGE_LIVE === "1" && Boolean(process.env.SERV_API_KEY);

const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: (_, key) => Reflect.get(state.db as object, key) }) }));
vi.mock("@/lib/auth-route", () => ({ getUserFromRequest: async () => state.user }));

type Copy = { definition: AgentDefinition; code: Record<string, StepCode>; settings: Record<string, unknown>; memory: Record<string, unknown>; timezone?: string };
const copy: Copy = process.env.JUDGE_COPY
  ? (JSON.parse(readFileSync(process.env.JUDGE_COPY, "utf8")) as Copy)
  : { ...(v1 as unknown as Copy), settings: { github_repo: "iam25th1/boardofserv" }, memory: { last_item_date: "2026-11-17T00:00:25Z" }, timezone: "UTC" };

const ledger = new Ledger({ serv: 20, dolphin: 0 }, globalThis.fetch);
let client: PGlite;
let db: PgliteDatabase<typeof schema>;
const price = modelPrices(process.env);
const usd = () => ledger.calls.filter((c) => c.to === "serv" && typeof c.status === "number").reduce((t, c) => t + ((c.promptTokens ?? 0) * price.serv.input + (c.completionTokens ?? 0) * price.serv.output) / 1e6, 0);

beforeAll(async () => {
  if (!enabled) return;
  ({ client, db } = await testDb());
  state.db = db;
  vi.stubEnv("FALLBACK_API_KEY", "");
  vi.stubGlobal("fetch", ledger.fetch);
});
afterAll(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await client?.close();
});

const post = (url: string, body?: unknown) => new Request(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const at = (id: string) => ({ params: Promise.resolve({ id }) });

describe.skipIf(!enabled)("the GitHub judge, live", () => {
  it("moves a copy of the verifier to the new judge through Switch, and checks the latest 5 again: no truncation findings, the merge skipped, counts that match", { timeout: 600_000 }, async () => {
    ledger.agent = "judge";
    const rt = serverRuntime();
    const owner = await addUser(db, "live.judge");
    state.user = owner;
    // Telegram linked (a stand-in chat): nothing is sent from here.
    await keep(rt, owner.id, "telegram", "@live_judge", { chatId: 5401, userId: 5401 });
    const [agent] = await db.insert(schema.agents).values({ ownerUserId: owner.id, name: copy.definition.name }).returning();
    const [version] = await db.insert(schema.agentVersions).values({ agentId: agent!.id, number: 1, state: "published", publishedAt: new Date(), definition: copy.definition, code: copy.code }).returning();
    const row = await install(rt, { ownerUserId: owner.id, agent: agent!, version: version!, answers: { settings: copy.settings, rules: {}, timezone: copy.timezone ?? "UTC", minGapMinutes: 0 } });
    await db.update(schema.agentInstallations).set({ memory: copy.memory }).where(eq(schema.agentInstallations.id, row.id));

    // The worker's upgrade, then the copy's page: Version 2 is ready.
    expect(await upgradeRecipeAgents(rt)).toBe(1);
    const page = await import("@/app/api/installations/[id]/route");
    const shown = ((await (await page.GET(new Request(`http://localhost/api/installations/${row.id}`), at(row.id))).json()) as { installation: InstallationDTO }).installation;
    expect(shown.newer).toMatchObject({ version: 2, breaking: null });

    // Switch, through its route.
    const switched = await (await import("@/app/api/installations/[id]/version/route")).POST(post(`/api/installations/${row.id}/version`), at(row.id));
    expect(switched.status).toBe(200);
    const after = ((await switched.json()) as { installation: InstallationDTO }).installation;
    expect(after).toMatchObject({ version: 2, judges: true });
    expect(after.settings.map((s) => s.value)).toEqual(Object.values(copy.settings));

    // Check the latest 5 again, through its route, and the run it queued.
    const pressed = await (await import("@/app/api/installations/[id]/control/route")).POST(post(`/api/installations/${row.id}/control`, { action: "recheck" }), at(row.id));
    expect(pressed.status).toBe(200);
    const claimed = (await claimJob(rt, "live"))!;
    expect(claimed.trigger).toEqual({ kind: "manual", latest: true });
    await runJob(rt, claimed, "live");
    await ledger.settled();
    const [job] = await db.select().from(schema.agentJobs).where(eq(schema.agentJobs.id, claimed.id));
    const steps = await db.select().from(schema.agentJobSteps).where(eq(schema.agentJobSteps.jobId, claimed.id));
    const tools = steps.flatMap((s) => ((s.tools ?? []) as { tool: string; args: Record<string, unknown>; error: string | null }[]).map((t) => ({ step: s.stepId, tool: t.tool, op: t.args?.op ?? null, sha: t.args?.sha ?? null, error: t.error })));
    const [cost] = await db.select({ micros: sql<string>`coalesce(sum(${schema.agentModelUsage.cost}), 0)::text` }).from(schema.agentModelUsage).where(eq(schema.agentModelUsage.jobId, claimed.id));
    const messages = await db.select().from(schema.agentMessages).where(and(eq(schema.agentMessages.installationId, row.id), eq(schema.agentMessages.from, "agent")));
    const [now] = await db.select().from(schema.agentInstallations).where(eq(schema.agentInstallations.id, row.id));
    const message = messages.at(-1)?.text ?? "";
    const report = { job: { status: job!.status, reason: job!.reason, usd: Number(cost?.micros ?? "0") / 1e6 }, tools, message, memoryBefore: copy.memory, memoryAfter: now!.memory, servUsd: usd(), calls: ledger.calls };
    if (process.env.JUDGE_REPORT) writeFileSync(process.env.JUDGE_REPORT, JSON.stringify(report, null, 2));
    console.log(`\n${message}\n`);

    expect(job!.status, job!.reason ?? "").toBe("done");
    const lines = message.split("\n");
    // No finding about cut, partial or missing content.
    expect(message).not.toMatch(NOT_SEEN);
    // The merge skipped, its changes never read.
    expect(lines.some((l) => /^Skipped [0-9a-f]{7} Merge .* \(a merge\)$/.test(l))).toBe(true);
    expect(lines[0]).toMatch(/ 1 merge skipped\.$/);
    // The counts are the verdict lines'.
    const verdicts = lines.filter((l) => /^(?:Critical|Problem|Minor|Passed) [0-9a-f]{7} /.test(l)).map((l) => l.split(" ")[0]!.toLowerCase());
    const count = (w: string) => verdicts.filter((v) => v === w).length;
    const said = Object.fromEntries([...lines[0]!.matchAll(/(\d+) (critical|problems?|minor|passed)/g)].map((m) => [m[2]!.replace(/s$/, "").replace("passed", "passed"), Number(m[1])]));
    expect(said).toEqual(Object.fromEntries([["critical", count("critical")], ["problem", count("problem")], ["minor", count("minor")], ["passed", count("passed")]].filter(([, n]) => Number(n) > 0)));
    expect(lines[0]).toMatch(new RegExp(`: ${verdicts.length} commits checked`));
    expect(tools.filter((t) => t.tool === "serv.reason").length).toBe(verdicts.length);
    // Its place never moved back.
    expect(Date.parse(String((now!.memory as Record<string, unknown>).last_item_date))).toBeGreaterThanOrEqual(Date.parse(String(copy.memory.last_item_date)));
    expect(usd()).toBeLessThan(1);
  });
});
