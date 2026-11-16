// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { and, eq, sql } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { modelConfig } from "@/lib/model";
import { servOnly } from "@/lib/agents/build";
import { checkDefinition, type AgentDefinition, type CodeStepDef } from "@/lib/agents/definition";
import type { StepCode } from "@/lib/agents/types";
import { mismatchFinding } from "@/lib/agents/argKinds";
import { repaired } from "@/lib/agents/plan";
import { reviewVersion } from "@/lib/agents/vetting";
import { versionsOf } from "@/lib/agents/store";
import { claimJob, enqueue, runJob } from "@/lib/agents/runtime/jobs";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { isDateText } from "@/lib/connections/reads";
import { keep } from "@/lib/connections/vault";
import type { AgentBuilderDTO } from "@/lib/types";
import { checkerDefinition, V2_FETCH, V2_SAVE, V3_FETCH, V3_MESSAGE, V3_SAVE, v2Checker } from "./githubChecker";
import { addUser, testDb } from "./helperDb";
import { Ledger } from "./suite/live";
import { runJourney } from "./suite/journey";
import type { SuiteRequest } from "./suite/requests";

// The review and runs brief, live on iam25th1/boardofserv: SERV and
// Dolphin answer on the site's own keys from the environment, and GitHub's
// public API is read for real, with no key. Nothing else is reached.
//
// - review: the review before publishing passes code that judges code
//   with serv.reason, and holds code that passes a commit's sha as
//   GitHub's since.
// - checker: the live owner's own sentence, answered as they answered it
//   (every hour, iam25th1/boardofserv, Telegram), planned, built, tried,
//   published and set up; no made-up rule; Run it for real starts from
//   iam25th1/boardofserv; then one run for real: at most 5 commits judged,
//   a message (or an all-clear) sent, its place saved as a date, under
//   $0.05 of model calls; and a run right after judges nothing again.
//
// Off unless RUN_REVIEW_LIVE=1 with SERV_API_KEY and DOLPHIN_API_KEY.
// REVIEW_REPORT keeps what happened (never a key).
//
//   RUN_REVIEW_LIVE=1 REVIEW_REPORT=review.json npx vitest run src/test/review-live.test.ts

process.env.OPENSERV_KEY_ENC_KEY ||= randomBytes(32).toString("base64");

const enabled = process.env.RUN_REVIEW_LIVE === "1" && Boolean(process.env.SERV_API_KEY) && Boolean(process.env.DOLPHIN_API_KEY);
const BUDGET = { serv: Number(process.env.LIVE_SERV_BUDGET ?? 80), dolphin: Number(process.env.LIVE_DOLPHIN_BUDGET ?? 20) };
const ONLY = (process.env.REVIEW_ONLY ?? "review,run,checker").split(",");
const REPO = "iam25th1/boardofserv";

const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: (_, key) => Reflect.get(state.db as object, key) }) }));
vi.mock("@/lib/auth-route", () => ({ getUserFromRequest: async () => state.user }));

// The live owner's words, as they wrote them, and their answers.
const CHECKER: SuiteRequest = {
  id: "checker",
  name: "GitHub code quality checker",
  says: "an ai agent that check  my github repo;  code quality",
  knows: [
    [/when should it run|how often/i, "Every hour"],
    [/repositor|which repo|github/i, REPO],
    [/where|send|tell|results go|report/i, "Telegram"],
    [/\bask\b|approv|permission|confirm|before/i, "It never needs to ask me anything first."],
  ],
  otherwise: "Judge the quality of each new commit and tell me what it found.",
  setup: [[/repositor|repo/i, REPO]],
};

const ledger = new Ledger(BUDGET, globalThis.fetch);
let client: PGlite;
let db: PgliteDatabase<typeof schema>;
const report: Record<string, unknown> = {};
const save = () => process.env.REVIEW_REPORT && writeFileSync(process.env.REVIEW_REPORT, JSON.stringify({ ...report, calls: ledger.calls }, null, 2));

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

const ok = (source: string): StepCode => ({ spec: "", status: "approved", source, rounds: 1, note: null, updatedAt: new Date().toISOString() });
// Judging one commit at a time with SERV, its place saved after each.
const JUDGE = `async function run(input, tools) {
  const violations = [];
  let files = 0;
  for (const c of (input.commits || []).slice().reverse()) {
    const got = await tools.github.read({ op: "commit", repo: input.settings.github_repo, sha: c.sha });
    files += got.items.length;
    const r = await tools.serv.reason({ task: "Judge the quality of this commit's changes: list each real problem in a few words, or nothing.", data: { message: c.message, files: got.items }, answer: { violations: "list" } });
    for (const v of r.violations) violations.push({ file: "", type: "quality", severity: "info", line: 0, message: v });
    await tools.memory.set({ key: "last_check_date", value: c.date });
  }
  return { violations, quality_summary: { files_checked: files, violations_total: violations.length } };
}`;

describe.skipIf(!enabled)("review and runs, live", () => {
  it.runIf(ONLY.includes("review"))("passes code that judges code with serv.reason, and holds a sha passed as GitHub's since", { timeout: 600_000 }, async () => {
    ledger.agent = "review";
    const serv = servOnly(modelConfig(process.env));
    const logged: string[] = [];
    const c = checkDefinition(repaired(structuredClone(checkerDefinition())));
    if (!c.ok) throw new Error(c.errors.join("; "));
    const judging = { definition: c.definition, code: { fetch_commits: ok(V3_FETCH), analyze_quality: ok(JUDGE), make_send_report_action: ok(V3_MESSAGE), save_last_check: ok(V3_SAVE) } };
    const passed = await reviewVersion(judging.definition, judging.code, serv, { now: new Date(), fetchImpl: ledger.fetch, log: (l) => logged.push(l) });
    const planted = v2Checker();
    const held = await reviewVersion(planted.definition, planted.code, serv, { now: new Date(), fetchImpl: ledger.fetch, log: (l) => logged.push(l) });
    await ledger.settled();
    report.review = { passed, held, logged };
    save();
    expect(passed.by).toBe("serv");
    expect(passed.status).toBe("passed");
    expect(passed.findings.filter((f) => f.severity === "blocking")).toEqual([]);
    expect(held.status).toBe("blocked");
    expect(held.findings).toContainEqual({ step: "Fetch recent commits", severity: "blocking", finding: mismatchFinding({ tool: "github.read", arg: "since", wants: "date", got: "id", value: "since" }) });
    expect([V2_FETCH, V2_SAVE].join("")).toContain("last_commit_sha");
  });

  // The checker as a build of it would run: one call to SERV a commit,
  // with its changes; set up on the live repository and run twice.
  it.runIf(ONLY.includes("run"))("judges at most 5 of the repository's commits with their changes for under 5 cents, tells its owner, keeps its place, and judges nothing again", { timeout: 900_000 }, async () => {
    ledger.agent = "run";
    const user = await addUser(db, "live.run");
    const c = checkDefinition(repaired(structuredClone(checkerDefinition())));
    if (!c.ok) throw new Error(c.errors.join("; "));
    const [agent] = await db.insert(schema.agents).values({ ownerUserId: user.id, name: c.definition.name }).returning();
    const [version] = await db.insert(schema.agentVersions).values({ agentId: agent!.id, number: 1, state: "published", publishedAt: new Date(), definition: c.definition, code: { fetch_commits: ok(V3_FETCH), analyze_quality: ok(JUDGE), make_send_report_action: ok(V3_MESSAGE), save_last_check: ok(V3_SAVE) } }).returning();
    const [inst] = await db.insert(schema.agentInstallations).values({ agentId: agent!.id, versionId: version!.id, ownerUserId: user.id, mocks: { sheets: {}, search: {}, wallet: { balanceUsdc: 0 } }, timezone: "UTC", minGapMinutes: 0, settings: { github_repo: REPO } }).returning();
    const rt = serverRuntime();
    const runOnce = async () => {
      const job = await enqueue(rt, inst!, { kind: "manual" });
      await runJob(rt, (await claimJob(rt, "live"))!, "live");
      await ledger.settled();
      const [done] = await db.select().from(schema.agentJobs).where(eq(schema.agentJobs.id, job.id));
      const steps = await db.select().from(schema.agentJobSteps).where(eq(schema.agentJobSteps.jobId, job.id));
      const [cost] = await db.select({ micros: sql<string>`coalesce(sum(${schema.agentModelUsage.cost}), 0)::text` }).from(schema.agentModelUsage).where(eq(schema.agentModelUsage.jobId, job.id));
      const tools = steps.flatMap((x) => ((x.tools ?? []) as { tool: string; args: Record<string, unknown>; error: string | null }[]).map((t) => ({ step: x.stepId, tool: t.tool, op: (t.args?.op as string | undefined) ?? null, error: t.error })));
      return { job: done!, tools, usd: Number(cost?.micros ?? "0") / 1e6 };
    };
    const first = await runOnce();
    const told = (await db.select().from(schema.agentMessages).where(eq(schema.agentMessages.installationId, inst!.id))).map((m) => m.text);
    const [after] = await db.select().from(schema.agentInstallations).where(eq(schema.agentInstallations.id, inst!.id));
    const second = await runOnce();
    report.run = { first: { status: first.job.status, outcome: first.job.outcome, reason: first.job.reason, usd: first.usd, tools: first.tools }, told, memory: after!.memory, second: { status: second.job.status, outcome: second.job.outcome, reason: second.job.reason, usd: second.usd, tools: second.tools } };
    save();
    expect(first.job.status, first.job.reason ?? "").toBe("done");
    const read = first.tools.filter((t) => t.tool === "github.read" && t.op === "commit");
    expect(read.length).toBeGreaterThan(0);
    expect(read.length).toBeLessThanOrEqual(5);
    expect(first.tools.filter((t) => t.tool === "serv.reason").length).toBe(read.length + 1);
    expect(first.usd).toBeLessThan(0.05);
    expect(told.length).toBe(1);
    expect(isDateText(String((after!.memory as Record<string, unknown>).last_check_date ?? ""))).toBe(true);
    expect(second.tools.filter((t) => t.tool === "serv.reason" || t.op === "commit")).toEqual([]);
  });

  it.runIf(ONLY.includes("checker"))("plans the owner's checker with nothing made up, starts its setup from their repository, and judges at most 5 commits for under 5 cents", { timeout: 3_600_000 }, async () => {
    ledger.agent = CHECKER.id;
    const user = await addUser(db, "live.checker");
    state.user = user;
    // Telegram linked (a stand-in chat), for where it sends.
    await keep(serverRuntime(), user.id, "telegram", "@live_checker", { chatId: 5301, userId: 5301 });
    const journey = await runJourney(CHECKER, { db, user, ledger });
    await ledger.settled();
    // Where it got to, kept whatever happened.
    const [made] = await db.select().from(schema.agents).where(eq(schema.agents.ownerUserId, user.id));
    const drafted = made ? (await versionsOf(made.id))[0] : undefined;
    report.checker = { journey, draft: drafted ? { definition: drafted.definition, code: drafted.code, bench: drafted.bench, test: drafted.testResult, heal: drafted.heal } : null };
    save();
    expect(journey.stage, journey.failure ?? "").toBe(6);

    // The plan: no rule its owner never gave, nothing it can't measure.
    const [agent] = await db.select().from(schema.agents).where(eq(schema.agents.ownerUserId, user.id));
    const v = (await versionsOf(agent!.id)).find((x) => x.state === "published")!;
    const d = v.definition as AgentDefinition;
    report.checker = { journey, definition: d, code: v.code, review: v.review };
    save();
    for (const r of d.rules) expect(`${r.label} ${r.help}`, r.key).not.toMatch(/coverage|complexity/i);
    for (const s of d.settings) expect(`${s.label} ${s.help}`, s.key).not.toMatch(/coverage/i);
    // Run it for real starts from the repository the owner named.
    const agentRoute = await import("@/app/api/agents/[id]/route");
    const builder = ((await (await agentRoute.GET(new Request(`http://localhost/api/agents/${agent!.id}?view=builder`), { params: Promise.resolve({ id: agent!.id }) })).json()) as { builder: AgentBuilderDTO }).builder;
    const repoSetting = d.settings.find((s) => /repo/i.test(`${s.key} ${s.label}`))!;
    expect(String(builder.runnable!.defaults[repoSetting.key] ?? "")).toContain(REPO);
    // Each code step's code checks out as built today.
    for (const s of d.steps.filter((x): x is CodeStepDef => x.kind === "code")) expect(v.code[s.id]?.status, s.id).toBe("approved");

    // One run for real, against the live repository.
    const rt = serverRuntime();
    const [inst] = await db.select().from(schema.agentInstallations).where(eq(schema.agentInstallations.agentId, agent!.id));
    const runOnce = async () => {
      const job = await enqueue(rt, inst!, { kind: "manual" });
      await runJob(rt, (await claimJob(rt, "live"))!, "live");
      await ledger.settled();
      const [done] = await db.select().from(schema.agentJobs).where(eq(schema.agentJobs.id, job.id));
      const steps = await db.select().from(schema.agentJobSteps).where(eq(schema.agentJobSteps.jobId, job.id));
      const [cost] = await db.select({ micros: sql<string>`coalesce(sum(${schema.agentModelUsage.cost}), 0)::text` }).from(schema.agentModelUsage).where(eq(schema.agentModelUsage.jobId, job.id));
      const tools = steps.flatMap((s) => ((s.tools ?? []) as { tool: string; args: Record<string, unknown>; error: string | null }[]).map((t) => ({ step: s.stepId, tool: t.tool, args: t.args, error: t.error })));
      return { job: done!, steps, tools, usd: Number(cost?.micros ?? "0") / 1e6 };
    };
    const first = await runOnce();
    const messages = await db.select().from(schema.agentMessages).where(and(eq(schema.agentMessages.installationId, inst!.id), eq(schema.agentMessages.from, "agent")));
    const [after] = await db.select().from(schema.agentInstallations).where(eq(schema.agentInstallations.id, inst!.id));
    report.checker = { journey, definition: d, code: v.code, review: v.review, first: { status: first.job.status, outcome: first.job.outcome, reason: first.job.reason, usd: first.usd, tools: first.tools.map((t) => ({ step: t.step, tool: t.tool, op: t.args?.op ?? null, error: t.error })), steps: first.steps.map((s) => ({ step: s.stepId, status: s.status, note: s.note, costUsd: s.costUsd })) }, messages: messages.map((m) => m.text), memory: after!.memory };
    save();
    expect(first.job.status, first.job.reason ?? "").toBe("done");
    // At most 5 commits read, judged by SERV (with each one's changes, or
    // from the list), one call a commit at most.
    expect(first.tools.filter((t) => t.tool === "github.read" && (t.args?.op === "commit" || t.args?.op === "pull")).length).toBeLessThanOrEqual(5);
    expect(first.steps.filter((x) => Number(x.costUsd) > 0).length).toBeGreaterThan(0);
    expect(first.tools.filter((t) => t.tool === "serv.reason").length).toBeLessThanOrEqual(6);
    expect(first.usd).toBeLessThan(0.05);
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages.at(-1)!.text.trim().length).toBeGreaterThan(0);
    // Its place, a date.
    const place = Object.values(after!.memory as Record<string, unknown>).filter((x): x is string => typeof x === "string" && isDateText(x));
    expect(place.length).toBeGreaterThanOrEqual(1);

    // Right after: nothing new, nothing judged again.
    const second = await runOnce();
    report.checker = { ...(report.checker as object), second: { status: second.job.status, outcome: second.job.outcome, reason: second.job.reason, usd: second.usd, tools: second.tools.map((t) => ({ step: t.step, tool: t.tool, op: t.args?.op ?? null, error: t.error })) } };
    save();
    expect(second.tools.filter((t) => t.tool === "github.read" && t.args?.op === "commit")).toEqual([]);
    expect(second.tools.filter((t) => t.tool === "serv.reason")).toEqual([]);
  });
});
