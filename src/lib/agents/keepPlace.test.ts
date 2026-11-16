// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { checkerDefinition } from "@/test/githubChecker";
import { publishedAgent, testRuntime, type TestRuntime } from "@/test/runtimeFixtures";
import { forgetPublicReads } from "../connections/publicReads";
import { checkCode } from "./code";
import { checkDefinition, type AgentDefinition, type CodeStepDef } from "./definition";
import { repaired } from "./plan";
import { DATE_CURSOR, diffsNote, eachItemNote, firstRunNote } from "./planRepairs";
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
  it("keeps its place as a date the runtime keeps, reads 5 at most, and judges one item at a time", () => {
    const d = repair(checkerDefinition());
    expect(d.memory).toEqual([{ key: "last_check_date", type: "text", description: "ISO format timestamp of the last analysis to fetch only commits since then" }]);
    expect(code(d, "fetch_commits").description).toContain(firstRunNote("last_check_date"));
    const judge = code(d, "analyze_quality");
    expect(judge.description).toContain(eachItemNote());
    expect(judge.tools).toEqual(["github.read", "serv.reason"]);
    expect(code(d, "save_last_check").description).toMatch(/is the newest item's date \(ISO 8601\), never its sha or id\.$/);
    expect(judge.description).toContain(diffsNote());
    // Repaired again, it reads the same.
    expect(repair(d)).toEqual(d);
  });

  it("judges each item on its changes: a judging step that only had the titles reads them", () => {
    // Live, the planned checker scored commits from their messages alone.
    const base = checkerDefinition();
    const titles: AgentDefinition = { ...base, steps: base.steps.map((s) => (s.id === "analyze_quality" && s.kind === "code" ? { ...s, inputs: ["commits"], tools: ["serv.reason"], description: "For each commit, ask serv.reason to judge its quality from its message. Return violations and quality_summary." } : s)) };
    const d = repair(titles);
    const judge = code(d, "analyze_quality");
    expect(judge.tools).toEqual(["serv.reason", "github.read"]);
    expect(judge.inputs).toEqual(["commits", "settings"]);
    expect(judge.description).toContain(diffsNote());
    const fromTitles = `async function run(input, tools) {
  const violations = [];
  for (const c of (input.commits || []).slice().reverse()) {
    const r = await tools.serv.reason({ task: "Judge this commit.", data: { message: c.message }, answer: { violations: "list" } });
    violations.push(...r.violations);
  }
  return { violations, quality_summary: { files_checked: 0, violations_total: violations.length } };
}`;
    expect(checkCode(fromTitles, judge, d)).toMatch(/^It judges the items without reading their changes/);
  });

  it("turns a place kept as a sha into the item's date, everywhere the plan names it", () => {
    const d = repair(checkerDefinition({ memory: { key: "last_commit_sha", type: "text", description: "SHA of the last commit analyzed to fetch only new commits on subsequent runs" } }));
    expect(d.memory).toEqual([{ key: "last_commit_date", type: "text", description: DATE_CURSOR }]);
    expect(JSON.stringify(d.steps)).not.toContain("last_commit_sha");
    expect(code(d, "fetch_commits").description).toContain("memory.last_commit_date");
    expect(code(d, "fetch_commits").description).toContain("and keeps memory.last_commit_date itself");
  });

  it("gets a place, a date, when it judges what it reads and kept none", () => {
    const base = checkerDefinition();
    const none: AgentDefinition = { ...base, memory: [], steps: base.steps.filter((s) => s.id !== "save_last_check").map((s) => (s.id === "send_report_action" ? { ...s, next: null } : s.id === "fetch_commits" ? { ...s, inputs: ["settings"], description: "Read the latest commits of settings.github_repo with github.read." } : s)) };
    const d = repair(none);
    expect(d.memory).toEqual([{ key: "last_item_date", type: "text", description: DATE_CURSOR }]);
    expect(code(d, "fetch_commits").inputs).toEqual(["settings", "memory"]);
    expect(code(d, "fetch_commits").description).toContain(firstRunNote("last_item_date"));
    expect(code(d, "analyze_quality").description).toContain(eachItemNote());
  });

  it("keeps its place in the step that reads, when a step of its own looked it up first", () => {
    // Live: a step read the last commit from memory, the reading step got
    // it as an input, and its place was saved only after an issue was sent,
    // so a clean run never saved it.
    const base = checkerDefinition({ memory: { key: "last_checked_commit", type: "text", description: "The last commit checked" } });
    const lookedUp: AgentDefinition = {
      ...base,
      steps: [
        { id: "read_last_commit", kind: "code", title: "Read the last commit checked", description: "Read memory.last_checked_commit with memory.get and return last_commit.", inputs: ["memory"], outputs: ["last_commit"], tools: ["memory.get"], next: "fetch_commits" },
        ...base.steps.map((s) =>
          s.id === "fetch_commits" && s.kind === "code"
            ? { ...s, inputs: ["last_commit", "settings"], description: "Read the commits of settings.github_repo after last_commit with github.read, with each commit's changed files and patches. Return commits." }
            : s.id === "analyze_quality" && s.kind === "code"
              ? { ...s, tools: ["serv.reason"] as CodeStepDef["tools"], inputs: ["commits"] }
              : s,
        ),
      ],
    };
    const d = repair(lookedUp);
    expect(d.memory).toEqual([{ key: "last_checked_commit", type: "text", description: DATE_CURSOR }]);
    expect(code(d, "fetch_commits").inputs).toEqual(["last_commit", "settings", "memory"]);
    expect(code(d, "fetch_commits").description).toContain(firstRunNote("last_checked_commit"));
    const judge = code(d, "analyze_quality");
    expect(judge.description).toContain(eachItemNote());
    // It has the changes already: it isn't told to read them again.
    expect(judge.tools).toEqual(["serv.reason"]);
    expect(judge.description).not.toContain(diffsNote());
  });

  it("goes item by item only through a list: a step that judges a summary of what was read has none", () => {
    // Live, a plan read a repository's metrics as one object and judged them.
    const base = checkerDefinition();
    const metrics: AgentDefinition = {
      ...base,
      steps: base.steps.map((s) => (s.id === "fetch_commits" && s.kind === "code" ? { ...s, outputs: ["commits"], shapes: { commits: "{ files_changed: number, commits: number }" } } : s)),
    };
    const d = repair(metrics);
    expect(code(d, "fetch_commits").description).toContain(firstRunNote("last_check_date"));
    expect(code(d, "analyze_quality").description).not.toContain(eachItemNote());
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

  // The same, with ids GitHub takes.
  const hex = commits.map((c, i) => ({ ...c, sha: `c0ffee${i}` }));
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

  it("keep their place themselves, a date, item by item as SERV judges each one, whatever the plan did", async () => {
    const d = repair(checkerDefinition());
    const u = await addUser(db, "feed.place");
    const p = await publishedAgent(db, u, { definition: d, code: {} });
    const [inst] = await db.insert(schema.agentInstallations).values({ agentId: p.agent.id, versionId: p.version.id, ownerUserId: u.id, mocks: { sheets: {}, search: {}, wallet: { balanceUsdc: 0 } }, timezone: "UTC" }).returning();
    const raw = hex.map((c) => ({ sha: c.sha, html_url: "", commit: { message: "Change", author: { name: "Ada", date: c.date } } }));
    rt.net.on(/\/repos\/acme\/place\/commits(?:\?|$)/, (req) => {
      const since = new URL(req.url).searchParams.get("since");
      return Response.json(since ? raw.filter((c) => Date.parse(c.commit.author.date) > Date.parse(since)) : raw);
    });
    rt.net.on(/\/repos\/acme\/place\/commits\/c0ffee/, () => Response.json({ files: [] }));
    const place = async () => ((await db.select().from(schema.agentInstallations).where(eq(schema.agentInstallations.id, inst!.id)))[0]!.memory as Record<string, unknown>).last_check_date ?? null;
    const step = d.steps[0]!;
    const job = (n: number) => new JobTools(rt, inst!, d, { id: `00000000-0000-0000-0000-00000000f0${n}0` } as schema.AgentJob);
    const first = job(1);
    expect(((await first.call(step, "github.read", { op: "commits", repo: "acme/place" })) as { items: { sha: string }[] }).items.map((c) => c.sha)).toEqual(["c0ffee0", "c0ffee1", "c0ffee2", "c0ffee3", "c0ffee4"]);
    // Oldest first: c0ffee4's changes read, nothing is judged yet; SERV's
    // answer judges it.
    await first.call(step, "github.read", { op: "commit", repo: "acme/place", sha: "c0ffee4" });
    expect(await place()).toBeNull();
    await first.judged();
    expect(await place()).toBe(at(5));
    // Stopped here, the next run starts after it.
    const next = job(2);
    expect(((await next.call(step, "github.read", { op: "commits", repo: "acme/place" })) as { items: { sha: string }[] }).items.map((c) => c.sha)).toEqual(["c0ffee0", "c0ffee1", "c0ffee2", "c0ffee3"]);
    // Every change read first, then judged one by one: the place follows the judging.
    for (const sha of ["c0ffee3", "c0ffee2", "c0ffee1", "c0ffee0"]) await next.call(step, "github.read", { op: "commit", repo: "acme/place", sha });
    expect(await place()).toBe(at(5));
    await next.judged();
    expect(await place()).toBe(at(3));
    // Done, everything it read is judged: its place is the newest.
    await next.settleFeed();
    expect(await place()).toBe(at(0.5));
    expect(((await job(3).call(step, "github.read", { op: "commits", repo: "acme/place" })) as { items: unknown[] }).items).toEqual([]);
    // Its place is a date the services take, never a time written for people.
    await expect(job(4).call(step, "memory.set", { key: "last_check_date", value: "11/16/2026, 10:31:42 PM" })).rejects.toThrow('"last_check_date" holds a date, ISO 8601');
  });

  it("never moves past an item not judged yet, when the code goes newest first", async () => {
    const d = repair(checkerDefinition());
    const u = await addUser(db, "feed.newest");
    const p = await publishedAgent(db, u, { definition: d, code: {} });
    const [inst] = await db.insert(schema.agentInstallations).values({ agentId: p.agent.id, versionId: p.version.id, ownerUserId: u.id, mocks: { sheets: {}, search: {}, wallet: { balanceUsdc: 0 } }, timezone: "UTC" }).returning();
    rt.net.on(/\/repos\/acme\/newest\/commits(?:\?|$)/, () => Response.json(commits.map((c) => ({ sha: c.sha, html_url: "", commit: { message: "Change", author: { name: "Ada", date: c.date } } }))));
    rt.net.on(/\/repos\/acme\/newest\/commits\/c/, () => Response.json({ files: [] }));
    const tools = new JobTools(rt, inst!, d, { id: "00000000-0000-0000-0000-00000000f0a0" } as schema.AgentJob);
    await tools.call(d.steps[0]!, "github.read", { op: "commits", repo: "acme/newest" });
    for (const sha of ["c0ffee0", "c0ffee1", "c0ffee2"]) {
      await tools.call(d.steps[0]!, "github.read", { op: "commit", repo: "acme/newest", sha });
      await tools.judged();
    }
    const [row] = await db.select().from(schema.agentInstallations).where(eq(schema.agentInstallations.id, inst!.id));
    expect((row!.memory as Record<string, unknown>).last_check_date ?? null).toBeNull();
  });
});
