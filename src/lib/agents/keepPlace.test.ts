// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { checkerDefinition, V3_ANALYZE } from "@/test/githubChecker";
import { publishedAgent, testRuntime, type TestRuntime } from "@/test/runtimeFixtures";
import { forgetPublicReads } from "../connections/publicReads";
import { checkCode } from "./code";
import { checkDefinition, type AgentDefinition, type CodeStepDef } from "./definition";
import { repaired } from "./plan";
import { DATE_CURSOR, eachItemNote, firstRunNote } from "./planRepairs";
import { feedArgs, feedItems, JobTools } from "./runtime/tools";

// The first run judges the latest 5 items (or those of the last 24 hours,
// whichever is fewer); after that it reads what came after a date it
// remembers, at most 5 a run, and saves that date right after each item it
// judges, so a run that stops part way never judges an item again. Live,
// version 3 saved its place only at the end, never got there, and read the
// same commits again.

const repair = (d: AgentDefinition): AgentDefinition => {
  const c = checkDefinition(repaired(structuredClone(d)));
  if (!c.ok) throw new Error(c.errors.join("; "));
  return c.definition;
};
const code = (d: AgentDefinition, id: string) => d.steps.find((s): s is CodeStepDef => s.id === id && s.kind === "code")!;

describe("a plan that reads new items", () => {
  it("keeps its place as a date, reads 5 at most, and saves the date after each item it judges", () => {
    const d = repair(checkerDefinition());
    expect(d.memory).toEqual([{ key: "last_check_date", type: "text", description: "ISO format timestamp of the last analysis to fetch only commits since then" }]);
    expect(code(d, "fetch_commits").description).toContain(firstRunNote("last_check_date"));
    const judge = code(d, "analyze_quality");
    expect(judge.description).toContain(eachItemNote("last_check_date"));
    expect(judge.tools).toEqual(["github.read", "serv.reason", "memory.set"]);
    expect(code(d, "save_last_check").description).toMatch(/is the newest item's date \(ISO 8601\), never its sha or id\.$/);
    // Repaired again, it reads the same.
    expect(repair(d)).toEqual(d);
  });

  it("turns a place kept as a sha into the item's date, everywhere the plan names it", () => {
    const d = repair(checkerDefinition({ memory: { key: "last_commit_sha", type: "text", description: "SHA of the last commit analyzed to fetch only new commits on subsequent runs" } }));
    expect(d.memory).toEqual([{ key: "last_commit_date", type: "text", description: DATE_CURSOR }]);
    expect(JSON.stringify(d.steps)).not.toContain("last_commit_sha");
    expect(code(d, "fetch_commits").description).toContain("memory.last_commit_date");
    expect(code(d, "fetch_commits").description).toContain("given to github.read as since (that date, never a sha or an id)");
  });

  it("gets a place, a date, when it judges what it reads and kept none", () => {
    const base = checkerDefinition();
    const none: AgentDefinition = { ...base, memory: [], steps: base.steps.filter((s) => s.id !== "save_last_check").map((s) => (s.id === "send_report_action" ? { ...s, next: null } : s.id === "fetch_commits" ? { ...s, inputs: ["settings"], description: "Read the latest commits of settings.github_repo with github.read." } : s)) };
    const d = repair(none);
    expect(d.memory).toEqual([{ key: "last_item_date", type: "text", description: DATE_CURSOR }]);
    expect(code(d, "fetch_commits").inputs).toEqual(["settings", "memory"]);
    expect(code(d, "fetch_commits").description).toContain(firstRunNote("last_item_date"));
    expect(code(d, "analyze_quality").description).toContain(eachItemNote("last_item_date"));
  });

  it("leaves a plan alone that only counts what it reads", () => {
    const base = checkerDefinition();
    const counts: AgentDefinition = {
      ...base,
      memory: [],
      steps: [
        { id: "fetch_commits", kind: "code", title: "Count today's commits", description: "Read the commits of settings.github_repo with github.read and return message, how many there are.", inputs: ["settings"], outputs: ["message"], tools: ["github.read"], next: "send_report_action" },
        { id: "send_report_action", kind: "action", title: "Send the count", action: "send_report", inputs: ["message"], outputs: [], next: null },
      ],
    };
    const d = repair(counts);
    expect(d.memory).toEqual([]);
    expect(code(d, "fetch_commits").description).not.toContain("the latest 5");
  });
});

describe("a step told to save its place item by item", () => {
  const d = repair(checkerDefinition());
  const judge = code(d, "analyze_quality");

  it("is sent back when it saves at the end, or not at all", () => {
    expect(checkCode(V3_ANALYZE, judge, d)).toMatch(/^It doesn't save its place item by item/);
    const atTheEnd = `async function run(input, tools) {
  const commits = (input.commits || []).slice().reverse();
  const violations = [];
  for (const c of commits) {
    const files = await tools.github.read({ op: "commit", repo: input.settings.github_repo, sha: c.sha });
    const r = await tools.serv.reason({ task: "Judge this commit's changes.", data: { files: files.items }, answer: { violations: "list" } });
    violations.push(...r.violations);
  }
  await tools.memory.set({ key: "last_check_date", value: commits.length ? commits[commits.length - 1].date : null });
  return { violations, quality_summary: { files_checked: 0, violations_total: violations.length } };
}`;
    expect(checkCode(atTheEnd, judge, d)).toMatch(/^It doesn't save its place item by item/);
  });

  it("passes when each item's date is saved right after it is judged", () => {
    const each = `async function run(input, tools) {
  const commits = (input.commits || []).slice().reverse();
  const violations = [];
  for (const c of commits) {
    const files = await tools.github.read({ op: "commit", repo: input.settings.github_repo, sha: c.sha });
    const r = await tools.serv.reason({ task: "Judge this commit's changes.", data: { files: files.items }, answer: { violations: "list" } });
    violations.push(...r.violations);
    await tools.memory.set({ key: "last_check_date", value: c.date });
  }
  return { violations, quality_summary: { files_checked: 0, violations_total: violations.length } };
}`;
    expect(checkCode(each, judge, d)).toBeNull();
  });
});

describe("a job's feed reads", () => {
  const now = Date.parse("2026-11-16T20:00:00Z");
  const at = (h: number) => new Date(now - h * 3_600_000).toISOString();
  // Newest first, as GitHub lists them.
  const commits = [0.5, 1, 2, 3, 5, 8, 13, 30, 50].map((h, i) => ({ sha: `c${i}`, date: at(h) }));

  it("on the first run, are the latest 5 from the last 24 hours, whichever is fewer", () => {
    expect(feedItems(commits, { since: null, now }).map((c) => c.sha)).toEqual(["c0", "c1", "c2", "c3", "c4"]);
    expect(feedItems(commits.slice(5), { since: null, now }).map((c) => c.sha)).toEqual(["c5", "c6"]);
    expect(feedArgs("github.read", { op: "commits", repo: "a/b", limit: 30 }, true)).toEqual({ op: "commits", repo: "a/b", limit: 5 });
  });

  it("after that, are the 5 oldest after the date it remembers, never that one again", () => {
    expect(feedItems(commits, { since: at(30), now }).map((c) => c.sha)).toEqual(["c2", "c3", "c4", "c5", "c6"]);
    expect(feedItems(commits, { since: at(3), now }).map((c) => c.sha)).toEqual(["c0", "c1", "c2"]);
    expect(feedArgs("github.read", { op: "commits", repo: "a/b", since: at(3) }, true)).toEqual({ op: "commits", repo: "a/b", since: at(3), limit: 100 });
  });

  it("are left as asked for an agent that keeps no place, and for other reads", () => {
    expect(feedArgs("github.read", { op: "commits", repo: "a/b", limit: 30 }, false)).toBeNull();
    expect(feedArgs("github.read", { op: "commit", repo: "a/b", sha: "abc1234" }, true)).toBeNull();
    expect(feedArgs("coingecko.read", { coins: ["bitcoin"] }, true)).toBeNull();
  });

  let client: PGlite;
  let db: PgliteDatabase<typeof schema>;
  let rt: TestRuntime;
  beforeAll(async () => {
    ({ client, db } = await testDb());
    rt = testRuntime(db, new Date(now));
  });
  beforeEach(() => forgetPublicReads());
  afterAll(async () => client.close());

  it("reach GitHub that way in a job", async () => {
    const d = checkerDefinition();
    const u = await addUser(db, "feed.owner");
    const p = await publishedAgent(db, u, { definition: d, code: {} });
    const [inst] = await db.insert(schema.agentInstallations).values({ agentId: p.agent.id, versionId: p.version.id, ownerUserId: u.id, mocks: { sheets: {}, search: {}, wallet: { balanceUsdc: 0 } }, timezone: "UTC" }).returning();
    const raw = commits.map((c) => ({ sha: c.sha, html_url: `https://github.com/acme/widgets/commit/${c.sha}`, commit: { message: "Change", author: { name: "Ada", date: c.date } } }));
    rt.net.on(/\/repos\/acme\/widgets\/commits/, () => Response.json(raw, { headers: { "x-ratelimit-remaining": "50", "x-ratelimit-reset": String(Math.floor(now / 1000) + 1800) } }));
    const tools = new JobTools(rt, inst!, d, { id: "00000000-0000-0000-0000-00000000f00d" } as schema.AgentJob);
    const first = (await tools.call(d.steps[0]!, "github.read", { op: "commits", repo: "acme/widgets", limit: 30 })) as { items: { sha: string }[] };
    expect(first.items.map((c) => c.sha)).toEqual(["c0", "c1", "c2", "c3", "c4"]);
    const asked = rt.net.calls.filter((c) => c.url.pathname === "/repos/acme/widgets/commits");
    expect(asked.at(-1)!.url.searchParams.get("per_page")).toBe("5");
    const later = (await tools.call(d.steps[0]!, "github.read", { op: "commits", repo: "acme/widgets", since: at(30) })) as { items: { sha: string }[] };
    expect(later.items.map((c) => c.sha)).toEqual(["c2", "c3", "c4", "c5", "c6"]);
  });
});
