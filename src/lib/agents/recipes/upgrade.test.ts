// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { installed, linkConnections, publishedAgent, testRuntime, type TestRuntime } from "@/test/runtimeFixtures";
import { answerIn, githubAnswering, REPO, sha } from "@/test/judgeFixtures";
import v1 from "@/test/fixtures/watchRecipeV1.json";
import { forgetPublicReads } from "../../connections/publicReads";
import { emptyBench, type StepCode } from "../types";
import type { AgentDefinition } from "../definition";
import { claimJob, runJob } from "../runtime/jobs";
import { control, install, installationDTO, loadInstallation, newerVersion, switchVersion } from "../runtime/installations";
import { JobTools } from "../runtime/tools";
import { matchesRecipe, recipeById, recipeUpgrade } from "./index";
import { upgradeRecipeAgents } from "./upgrade";
import { NOT_SEEN } from "./watch";

// Agents already built from the GitHub watch recipe get its new judge as a
// new version, which passes its test, shown as "Version N is ready" with
// Switch; switching keeps their settings and memory. "Check the latest 5
// again" runs once over the latest five, whatever the saved place, never
// moving it back. Live, the owner's GitHub Code Verifier (version 1, from
// the recipe as it was) sent "5 commits checked, 3 with problems" about
// truncated patches and a merge.

const V1 = v1 as unknown as { definition: AgentDefinition; code: Record<string, StepCode> };
// Where the live verifier had got to: the merge, the newest of the five.
const PLACE = "2026-11-17T00:00:25Z";

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
beforeAll(async () => ({ client, db } = await testDb()));
afterAll(async () => client.close());
beforeEach(() => forgetPublicReads());

// An owner with the verifier as it was built, running with its place kept.
async function verifier(rt: TestRuntime, name: string) {
  const owner = await addUser(db, name);
  await linkConnections(rt, owner);
  const p = await publishedAgent(db, owner, { definition: V1.definition, code: V1.code, bench: emptyBench() });
  const row = await install(rt, { ownerUserId: owner.id, agent: p.agent, version: p.version, answers: { settings: { github_repo: REPO }, rules: {}, timezone: "UTC", minGapMinutes: 0 } });
  await db.update(schema.agentInstallations).set({ memory: { last_item_date: PLACE } }).where(eq(schema.agentInstallations.id, row.id));
  return { owner, agent: p.agent, installation: row };
}

describe("an older build from the recipe, built again", () => {
  it("keeps everything the owner's: name, job, schedule, repository and the bar they gave", () => {
    const up = recipeUpgrade(V1.definition, V1.code)!;
    expect(up.recipe.rev).toBe(2);
    expect(up.definition).toMatchObject({ name: V1.definition.name, job: V1.definition.job, triggers: V1.definition.triggers, recipe: { id: "watch", variant: "commits", rev: 2 } });
    expect(up.definition.settings).toEqual(V1.definition.settings);
    expect(up.definition.memory).toEqual(V1.definition.memory);
    // The bar it was built with, read from its code.
    expect(up.definition.recipe!.task).toBe("Judge the quality of this commit's changes: name each real problem (a bug, a risky or unclear change, a missing test where it matters) in a few words, or none, and give a one-line verdict.");
    expect(up.code.judge_items!.source).toContain("What the owner asked for: Judge the quality of this commit's changes");
    expect(matchesRecipe(up.definition, up.code)).toBe(true);
    // The newest needs nothing.
    expect(recipeUpgrade(up.definition, up.code)).toBeNull();
    expect(matchesRecipe(V1.definition, V1.code)).toBe(false);
  });
});

describe("the owner's running verifier", () => {
  it("gets the new judge as version 2 that passed its test, shown as ready with Switch, which keeps its settings and memory", async () => {
    const rt = testRuntime(db, new Date("2026-11-17T02:00:00Z"));
    const { agent, installation } = await verifier(rt, "judge.owner");
    expect(await upgradeRecipeAgents(rt)).toBeGreaterThanOrEqual(1);
    const versions = await db.select().from(schema.agentVersions).where(eq(schema.agentVersions.agentId, agent.id));
    const v2 = versions.find((v) => v.number === 2)!;
    expect(v2).toMatchObject({ state: "published", testResult: { status: "passed" }, review: { status: "passed", by: "recipe" } });
    expect(v2.definition!.recipe).toMatchObject({ rev: 2 });
    // Once is enough: run again, nothing more is made.
    await upgradeRecipeAgents(rt);
    expect((await db.select().from(schema.agentVersions).where(eq(schema.agentVersions.agentId, agent.id))).length).toBe(2);

    const loaded = (await loadInstallation(rt, installation.id))!;
    expect(await newerVersion(rt, loaded)).toMatchObject({ version: 2, line: recipeById("watch")!.changes![2], breaking: null });
    const before = await installationDTO(rt, loaded);
    expect(before.newer).toMatchObject({ version: 2, breaking: null });
    await switchVersion(rt, loaded);
    const after = await installationDTO(rt, (await loadInstallation(rt, installation.id))!);
    expect(after).toMatchObject({ version: 2, newer: null, settings: before.settings, memory: before.memory, judges: true });
    expect(after.memory).toEqual([expect.objectContaining({ key: "last_item_date", value: PLACE })]);
  });

  it("checks the latest 5 again on its new judge: no truncation findings, the merge skipped, counts that match the verdicts", async () => {
    const rt = testRuntime(db, new Date("2026-11-17T02:00:00Z"));
    const gh = githubAnswering(rt.net);
    // SERV answering as it did live.
    rt.reasonAnswer = (request) => answerIn(request) ?? { verdict: "pass", findings: [] };
    const { installation } = await verifier(rt, "judge.recheck");
    await upgradeRecipeAgents(rt);
    await switchVersion(rt, (await loadInstallation(rt, installation.id))!);
    await control(rt, (await loadInstallation(rt, installation.id))!, "recheck");
    const [queued] = await db.select().from(schema.agentJobs).where(eq(schema.agentJobs.installationId, installation.id));
    expect(queued!.trigger).toEqual({ kind: "manual", latest: true });
    await runJob(rt, (await claimJob(rt, "w"))!, "w");
    const [job] = await db.select().from(schema.agentJobs).where(eq(schema.agentJobs.id, queued!.id));
    expect(job!.status, job!.reason ?? "").toBe("done");
    // The latest five were read whatever the place, the merge's changes not.
    expect(gh.read).not.toContain(sha("99bd945"));
    expect(gh.read.sort()).toEqual([sha("67a6193"), sha("5d2e3f0"), sha("65dcc3a"), sha("a40b9f6")].sort());
    expect(rt.reasoned).toHaveLength(4);
    const [message] = await db.select().from(schema.agentMessages).where(eq(schema.agentMessages.installationId, installation.id));
    const text = message!.text;
    expect(text).not.toMatch(NOT_SEEN);
    const lines = text.split("\n");
    expect(lines[0]).toBe("iam25th1/boardofserv: 4 commits checked: 4 passed. 1 merge skipped.");
    expect(lines.filter((l) => /^(?:Critical|Problem|Minor|Passed) [0-9a-f]{7} /.test(l))).toHaveLength(4);
    expect(lines).toContain("Skipped 99bd945 Merge pull request #10 from iam25th1/feat/reliable-builds (a merge)");
    expect(lines.at(-1)).toMatch(/^Not fully checked: \d+ files \(too large\)$/);
    // Its place is where it was: never moved back.
    const [after] = await db.select().from(schema.agentInstallations).where(eq(schema.agentInstallations.id, installation.id));
    expect((after!.memory as Record<string, unknown>).last_item_date).toBe(PLACE);
  });

  it("leaves an agent its owner is changing alone, and refuses Check the latest 5 again for one that judges no feed", async () => {
    const rt = testRuntime(db, new Date("2026-11-17T02:00:00Z"));
    const { agent } = await verifier(rt, "judge.drafting");
    await db.insert(schema.agentVersions).values({ agentId: agent.id, number: 2, state: "draft", definition: V1.definition, code: V1.code });
    await upgradeRecipeAgents(rt);
    const versions = await db.select().from(schema.agentVersions).where(eq(schema.agentVersions.agentId, agent.id));
    expect(versions.map((v) => [v.number, v.state]).sort()).toEqual([[1, "published"], [2, "draft"]]);

    const owner = await addUser(db, "judge.restock");
    const row = await installed(rt, owner, await publishedAgent(db, owner));
    const loaded = (await loadInstallation(rt, row.id))!;
    await expect(control(rt, loaded, "recheck")).rejects.toThrow("It doesn't judge what it reads, so there is nothing to check again.");
    expect((await installationDTO(rt, loaded)).judges).toBe(false);
  });
});

describe("the latest 5, whatever the place", () => {
  const run = async (rt: TestRuntime, inst: schema.AgentInstallation, d: AgentDefinition, latest: boolean, n: number) => {
    const tools = new JobTools(rt, inst, d, { id: `00000000-0000-0000-0000-0000000000${n}0`, trigger: latest ? { kind: "manual", latest: true } : { kind: "schedule" } } as unknown as schema.AgentJob);
    const step = d.steps.find((s) => s.id === "read_items")!;
    const got = (await tools.call(step, "github.read", { op: "commits", repo: REPO })) as { items: { sha: string }[] };
    return { tools, got };
  };

  it("reads the latest five on a check again, where a run on its schedule reads nothing new", async () => {
    const rt = testRuntime(db, new Date("2026-11-17T02:00:00Z"));
    githubAnswering(rt.net);
    const { installation } = await verifier(rt, "judge.latest");
    const d = recipeUpgrade(V1.definition, V1.code)!.definition;
    expect((await run(rt, installation, d, false, 1)).got.items).toEqual([]);
    const again = await run(rt, installation, d, true, 2);
    expect(again.got.items.map((c) => c.sha.slice(0, 7))).toEqual(["99bd945", "67a6193", "5d2e3f0", "65dcc3a", "a40b9f6"]);
    await again.tools.settleFeed();
    const [after] = await db.select().from(schema.agentInstallations).where(eq(schema.agentInstallations.id, installation.id));
    expect((after!.memory as Record<string, unknown>).last_item_date).toBe(PLACE);
  });

  it("moves the place on only when the five reach back to it, so nothing between is passed over", async () => {
    const rt = testRuntime(db, new Date("2026-11-17T02:00:00Z"));
    githubAnswering(rt.net);
    const { installation } = await verifier(rt, "judge.gap");
    const d = recipeUpgrade(V1.definition, V1.code)!.definition;
    // A place from before the five: commits between it and them were never judged.
    await db.update(schema.agentInstallations).set({ memory: { last_item_date: "2026-11-15T00:00:00Z" } }).where(eq(schema.agentInstallations.id, installation.id));
    const gap = await run(rt, installation, d, true, 3);
    await gap.tools.settleFeed();
    const [kept] = await db.select().from(schema.agentInstallations).where(eq(schema.agentInstallations.id, installation.id));
    expect((kept!.memory as Record<string, unknown>).last_item_date).toBe("2026-11-15T00:00:00Z");
    // A place within the five: on to the newest.
    await db.update(schema.agentInstallations).set({ memory: { last_item_date: "2026-11-16T23:44:37Z" } }).where(eq(schema.agentInstallations.id, installation.id));
    const within = await run(rt, installation, d, true, 4);
    await within.tools.settleFeed();
    const [moved] = await db.select().from(schema.agentInstallations).where(eq(schema.agentInstallations.id, installation.id));
    expect((moved!.memory as Record<string, unknown>).last_item_date).toBe(PLACE);
  });
});
