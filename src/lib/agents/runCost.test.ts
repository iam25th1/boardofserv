// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { checkerDefinition, V3_ANALYZE, V3_FETCH, V3_MESSAGE, V3_SAVE } from "@/test/githubChecker";
import { publishedAgent, testRuntime, type TestRuntime } from "@/test/runtimeFixtures";
import { forgetPublicReads } from "../connections/publicReads";
import { checkCode } from "./code";
import type { AgentDefinition, CodeStepDef } from "./definition";
import { allowancePause, allowanceStopped, budgetDTO } from "./metering";
import { repaired } from "./plan";
import { estimateReasonUsd, REASON_DATA_CAP, reasonRequest, trimData } from "./reason";
import { claimJob, enqueue, runJob } from "./runtime/jobs";
import { REASONS_STOP } from "./runner";
import { checkDefinition } from "./definition";
import type { StepCode } from "./types";

// What a run costs. Live, version 3 asked SERV once per changed file of
// every commit (112 calls), spent $0.244 in a job, used up the free 0.25
// USDC week and paused with nothing saved, so the next run would judge the
// same commits again. Now: one SERV call an item, with long text trimmed to
// a size; an estimate before each call; and a run that stops before its
// budget runs out, with the items it judged saved.

const ok = (source: string): StepCode => ({ spec: "", status: "approved", source, rounds: 1, note: null, updatedAt: "" });

// One call a commit; the runtime keeps its place as SERV judges each.
const JUDGE = `async function run(input, tools) {
  const violations = [];
  let files = 0;
  for (const c of (input.commits || []).slice().reverse()) {
    const got = await tools.github.read({ op: "commit", repo: input.settings.github_repo, sha: c.sha });
    files += got.items.length;
    const r = await tools.serv.reason({ task: "Judge this commit's changes for quality.", data: { message: c.message, files: got.items }, answer: { violations: "list" } });
    for (const v of r.violations) violations.push({ file: "", type: "style", severity: "info", line: 0, message: v });
  }
  return { violations, quality_summary: { files_checked: files, violations_total: violations.length } };
}`;

// The checker as plans are repaired now: its judging step saves its place.
const repairedChecker = (): AgentDefinition => {
  const c = checkDefinition(repaired(structuredClone(checkerDefinition())));
  if (!c.ok) throw new Error(c.errors.join("; "));
  return c.definition;
};

describe("one SERV call an item", () => {
  const d = repairedChecker();
  const judge = d.steps.find((s): s is CodeStepDef => s.id === "analyze_quality")!;

  it("sends back code that asks once for every file of every commit", () => {
    expect(checkCode(V3_ANALYZE, judge, d)).toBe("It asks SERV once for every part of every item (a loop inside a loop): ask once per item, with all of that item's parts (its changed files and their patches) together in data, so a run of 5 items makes 5 calls.");
    expect(checkCode(JUDGE, judge, d)).toBeNull();
  });

  it("sends back code that asks once for every changed file, gathered from every commit", () => {
    // Live: one step gathered every commit's files, the next asked SERV
    // about each, 30 calls for 5 commits.
    const perFile = `async function run(input, tools) {
  const files = (input.commits || []).flatMap((c) => c.files || []);
  const violations = [];
  for (const file of files) {
    const r = await tools.serv.reason({ task: "Judge this file.", data: file, answer: { violations: "list" } });
    violations.push(...r.violations);
  }
  return { violations, quality_summary: { files_checked: files.length, violations_total: violations.length } };
}`;
    expect(checkCode(perFile, { ...judge, description: "Judge each file's changes with serv.reason.", tools: ["serv.reason"] }, d)).toMatch(/^It asks SERV once for every changed file/);
  });

  it("trims what it hands SERV to a size, longest text first, keeping its shape", () => {
    const patch = (n: number) => `@@ -1,${n} +1,${n} @@\n${"+ a changed line of code\n".repeat(n)}`;
    const big = { message: "Big change", files: Array.from({ length: 30 }, (_, i) => ({ filename: `src/f${i}.ts`, patch: patch(60 + i) })) };
    const cut = trimData(big) as typeof big;
    expect(JSON.stringify(cut).length).toBeLessThanOrEqual(REASON_DATA_CAP);
    expect(cut.files).toHaveLength(30);
    expect(cut.files.every((f) => f.filename.startsWith("src/f") && f.patch.endsWith(" [cut]"))).toBe(true);
    const small = { message: "Small", files: [{ filename: "a.ts", patch: patch(2) }] };
    expect(trimData(small)).toBe(small);
    expect(reasonRequest({ task: "Judge it.", data: big })).toContain(" [cut]");
  });

  it("estimates a call before it is made, from what it sends and the answer it asks for", () => {
    const one = estimateReasonUsd({ task: "Judge this commit's changes.", data: { files: [{ patch: "+ x" }] }, answer: { violations: "list" } });
    const huge = estimateReasonUsd({ task: "Judge this commit's changes.", data: { files: Array.from({ length: 40 }, () => ({ patch: "+ y\n".repeat(400) })) }, answer: { violations: "list" } });
    expect(huge).toBeGreaterThan(one);
    // Trimmed, five commits and a message stay well under five cents.
    expect(5 * huge + estimateReasonUsd({ task: "Write the message.", data: { violations: [] }, answer: { text: "text" } })).toBeLessThan(0.05);
  });
});

describe("a run near its budget", () => {
  let client: PGlite;
  let db: PgliteDatabase<typeof schema>;
  let rt: TestRuntime;
  beforeAll(async () => ({ client, db } = await testDb()));
  beforeEach(() => {
    rt = testRuntime(db, new Date("2026-11-16T20:00:00Z"));
    forgetPublicReads();
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => client.close());

  const commits = [0.5, 1, 2, 3, 4].map((h, i) => ({ sha: `abc123${i}`, date: new Date(Date.parse("2026-11-16T20:00:00Z") - h * 3_600_000).toISOString() }));
  async function installedChecker(name: string, d: AgentDefinition = repairedChecker()) {
    const u = await addUser(db, name);
    const p = await publishedAgent(db, u, { definition: d, code: { fetch_commits: ok(V3_FETCH), analyze_quality: ok(JUDGE), make_send_report_action: ok(V3_MESSAGE), save_last_check: ok(V3_SAVE) } });
    const [inst] = await db.insert(schema.agentInstallations).values({ agentId: p.agent.id, versionId: p.version.id, ownerUserId: u.id, mocks: { sheets: {}, search: {}, wallet: { balanceUsdc: 0 } }, timezone: "UTC", settings: { github_repo: "acme/widgets" } }).returning();
    rt.net.on(/\/repos\/acme\/widgets\/commits(?:\?|$)/, () => Response.json(commits.map((c) => ({ sha: c.sha, html_url: "", commit: { message: "Change", author: { name: "Ada", date: c.date } } }))));
    rt.net.on(/\/repos\/acme\/widgets\/commits\/abc/, () => Response.json({ files: [{ filename: "src/app.ts", status: "modified", additions: 1, deletions: 1, patch: "+ b" }] }));
    rt.reasonAnswer = (_r, fields) => Object.fromEntries(fields.map((f) => [f, f === "violations" ? [] : "acme/widgets: no violations found."]));
    return { u, inst: inst! };
  }
  const run = async (inst: schema.AgentInstallation) => {
    const job = await enqueue(rt, inst, { kind: "manual" });
    await runJob(rt, (await claimJob(rt, "w"))!, "w");
    return (await db.select().from(schema.agentJobs).where(eq(schema.agentJobs.id, job.id)))[0]!;
  };

  it("judges at most 5 commits on its first run, sends its message and keeps its place", async () => {
    const { inst } = await installedChecker("cost.first");
    const job = await run(inst);
    expect(job).toMatchObject({ status: "done" });
    expect(rt.reasoned).toHaveLength(6);
    const [after] = await db.select().from(schema.agentInstallations).where(eq(schema.agentInstallations.id, inst.id));
    expect(after!.memory).toEqual({ last_check_date: commits[0]!.date });
    const told = await db.select().from(schema.agentMessages).where(eq(schema.agentMessages.installationId, inst.id));
    expect(told.map((m) => m.text)).toEqual(["acme/widgets: no violations found."]);
  });

  it("stops cleanly before its free allowance runs out, with the commits it judged saved, and says so", async () => {
    vi.stubEnv("AGENT_FREE_MODEL_ALLOWANCE_USDC", "0.006");
    const { inst } = await installedChecker("cost.stop");
    const job = await run(inst);
    expect(job).toMatchObject({ status: "cancelled", reason: allowanceStopped(6000n) });
    expect(allowanceStopped(6000n)).toBe("It stopped before its next call to SERV would run out its free model allowance of 0.006 USDC for this week. What it had done is saved, so its next run picks up from there: on Monday, or sooner on your own SERV key: add it on Connections.");
    const judged = rt.reasoned.length;
    expect(judged).toBeGreaterThan(0);
    expect(judged).toBeLessThan(5);
    const [after] = await db.select().from(schema.agentInstallations).where(eq(schema.agentInstallations.id, inst.id));
    // Oldest first: its place is the last commit it judged.
    expect(after!.memory).toEqual({ last_check_date: commits[5 - judged]!.date });
    expect(after).toMatchObject({ status: "paused", pausedReason: allowancePause(6000n) });
    // What it spent stayed within the allowance.
    expect(Number(job.costUsd)).toBeLessThanOrEqual(0.006);
    const told = await db.select().from(schema.agentMessages).where(eq(schema.agentMessages.installationId, inst.id));
    expect(told.map((m) => m.text)).toEqual([`GitHub code quality checker: ${allowanceStopped(6000n)}`]);
  });

  it("stops cleanly past a few calls to SERV in one run, whatever its code asks", async () => {
    // Code that asks about each commit four times over: 20 calls asked.
    const chatty = JUDGE.replace("const r = await tools.serv.reason(", "for (let k = 0; k < 3; k++) await tools.serv.reason({ task: \"Look again.\", data: { k }, answer: { violations: \"list\" } });\n    const r = await tools.serv.reason(");
    const u = await addUser(db, "cost.chatty");
    const d = repairedChecker();
    const p = await publishedAgent(db, u, { definition: d, code: { fetch_commits: ok(V3_FETCH), analyze_quality: ok(chatty), make_send_report_action: ok(V3_MESSAGE), save_last_check: ok(V3_SAVE) } });
    const [inst] = await db.insert(schema.agentInstallations).values({ agentId: p.agent.id, versionId: p.version.id, ownerUserId: u.id, mocks: { sheets: {}, search: {}, wallet: { balanceUsdc: 0 } }, timezone: "UTC", settings: { github_repo: "acme/widgets" } }).returning();
    rt.net.on(/\/repos\/acme\/widgets\/commits(?:\?|$)/, () => Response.json(commits.map((c) => ({ sha: c.sha, html_url: "", commit: { message: "Change", author: { name: "Ada", date: c.date } } }))));
    rt.net.on(/\/repos\/acme\/widgets\/commits\/abc/, () => Response.json({ files: [{ filename: "src/app.ts", status: "modified", additions: 1, deletions: 1, patch: "+ b" }] }));
    rt.reasonAnswer = (_r, fields) => Object.fromEntries(fields.map((f) => [f, f === "violations" ? [] : "ok"]));
    const job = await run(inst!);
    expect(job).toMatchObject({ status: "cancelled", reason: REASONS_STOP(8) });
    expect(rt.reasoned).toHaveLength(8);
    // The two commits it judged are its place.
    const [after] = await db.select().from(schema.agentInstallations).where(eq(schema.agentInstallations.id, inst!.id));
    expect((after!.memory as Record<string, unknown>).last_check_date).toBe(commits[3]!.date);
  });

  it("says plainly which weekly cap applies when it isn't the budget its owner set", async () => {
    const { inst } = await installedChecker("cost.cap");
    await db.update(schema.agentInstallations).set({ modelBudget: "2000000" }).where(eq(schema.agentInstallations.id, inst.id));
    const [row] = await db.select().from(schema.agentInstallations).where(eq(schema.agentInstallations.id, inst.id));
    expect(await budgetDTO(rt, row!)).toMatchObject({ budget: "2000000", allowance: "250000", free: true, ownKey: false });
  });
});
