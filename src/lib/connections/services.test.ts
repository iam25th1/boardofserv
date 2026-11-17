// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { publishedAgent, testRuntime, type TestRuntime } from "@/test/runtimeFixtures";
import { checkDefinition, connectionsNeeded, servicesOf, type AgentDefinition } from "../agents/definition";
import { planProblems } from "../agents/planRules";
import { JobTools } from "../agents/runtime/tools";
import { MockTools, OUTSIDE_TOOLS, ToolError } from "../agents/toolbox";
import { emptyBench } from "../agents/types";
import { InfraError } from "../agents/runner";
import { hookUrl, takePost } from "../agents/runtime/hooks";
import { CATALOG, servicesIn } from "./catalog";
import { callKey, headTail, TYPED_READS, typedRead } from "./reads";
import judgeCommits from "@/test/fixtures/judgeCommits.json";
import { keep, setWrites } from "./vault";

// Agents reach the catalog's services: a typed read where there is one,
// service.request for any read, service.send for a write (a declared
// action, with writing on), each through the owner's connection, only to
// a service the agent says it uses. On the test bench, each call is
// answered by its exact key.

const HOOK = "https://discord.com/api/webhooks/123456789/discord-webhook-secret-token";
const GH_KEY = "github_pat_test_secret_value_0001";

const wire = (o: Partial<AgentDefinition> = {}): AgentDefinition => {
  const c = checkDefinition({
    format: 1,
    name: "Repo watch",
    job: { does: "Reads new commits and posts them to Discord.", done: "Posted." },
    triggers: [{ kind: "schedule", every: "day", at: "09:00", description: "Every day at 9" }],
    settings: [{ key: "repos", label: "Repositories", type: "list", help: "owner/name, one or more", choices: [] }],
    rules: [],
    memory: [],
    steps: [
      { id: "read", kind: "code", title: "Read commits", description: "Read the commits of each repository in settings.repos with github.read.", inputs: ["settings"], outputs: ["commits"], tools: ["github.read", "service.request"], next: "make" },
      { id: "make", kind: "code", title: "Write the post", description: "Return post as service.send's arguments for Discord.", inputs: ["commits"], outputs: ["post"], tools: [], next: "send" },
      { id: "send", kind: "action", title: "Post it", action: "post", inputs: ["post"], outputs: [], next: null },
    ],
    actions: [{ id: "post", tool: "service.send", description: "Post the commits to Discord" }],
    services: ["discord", "rss"],
    limits: { maxSteps: 20, maxRunSeconds: 60, maxSpendUsd: 0.1 },
    ...o,
  });
  if (!c.ok) throw new Error(c.errors.join("; "));
  return c.definition;
};

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let rt: TestRuntime;
let owner: schema.User;
let d: AgentDefinition;
let inst: schema.AgentInstallation;

beforeAll(async () => {
  ({ client, db } = await testDb());
  rt = testRuntime(db);
  owner = await addUser(db, "services.owner");
  d = wire();
  const p = await publishedAgent(db, owner, { definition: d, code: {} });
  [inst] = await db.insert(schema.agentInstallations).values({ agentId: p.agent.id, versionId: p.version.id, ownerUserId: owner.id, mocks: { sheets: {}, search: {}, wallet: { balanceUsdc: 0 } } }).returning() as [schema.AgentInstallation];
});
afterAll(async () => client.close());

const step = (id: string) => d.steps.find((s) => s.id === id)!;

describe("the agent's own services", () => {
  it("are the ones it names and the ones its typed reads read", () => {
    expect(servicesOf(d)).toEqual(["discord", "rss", "github"]);
    // Discord needs connecting; a public GitHub repository and a feed don't.
    expect(connectionsNeeded(d).services).toEqual(["discord"]);
    expect(servicesIn("a mini agent that checks githubs and posts to my discord")).toEqual(["discord", "github"]);
  });

  it("must be the catalog's, and named when a step reaches one generically", () => {
    const bad = checkDefinition({ ...wire(), services: ["mastodon"] });
    expect(bad.ok ? [] : bad.errors.join(" ")).toMatch(/"mastodon", which isn't a service boardofserv reaches/);
    const unnamed = checkDefinition({ ...wire(), services: [] });
    expect(unnamed.ok ? [] : unnamed.errors.join(" ")).toMatch(/services must name it/);
  });

  it("are never reached by fetching their API", () => {
    const fetched = wire({ steps: [{ ...wire().steps[0]!, tools: ["web.fetch"], description: "Fetch https://api.github.com/repos/x/y/commits with web.fetch." } as AgentDefinition["steps"][number], ...wire().steps.slice(1)] });
    expect(planProblems(fetched).join(" ")).toMatch(/fetches GitHub's API with web.fetch: reach GitHub with github.read/);
  });
});

describe("a typed read", () => {
  it("reads a public GitHub repository with no key, in its own shape", async () => {
    rt.net.on(/api\.github\.com\/repos\/acme\/widgets\/commits/, () =>
      Response.json([{ sha: "abc1234", html_url: "https://github.com/acme/widgets/commit/abc1234", commit: { message: "Fix the parser\n\nLonger body", author: { name: "Ada", date: "2026-11-15T10:00:00Z" } } }]),
    );
    const tools = new JobTools(rt, inst, d, null);
    const got = await tools.call(step("read"), "github.read", { op: "commits", repo: "acme/widgets", limit: 5 });
    expect(got).toEqual({ items: [{ sha: "abc1234", message: "Fix the parser", author: "Ada", date: "2026-11-15T10:00:00Z", url: "https://github.com/acme/widgets/commit/abc1234", parents: 1 }] });
    const call = [...rt.net.calls].reverse().find((c) => c.url.host === "api.github.com")!;
    expect(call.headers.get("authorization")).toBeNull();
    expect(call.url.searchParams.get("per_page")).toBe("5");
  });

  it("says which commits are merges, and keeps a long patch's first and last lines with a note, never just its start", async () => {
    // The live repository's last five commits: a merge, and a test file
    // whose 13,000-character patch was judged "critical" for being cut off.
    const gh = judgeCommits as { list: { sha: string }[]; commits: Record<string, { files: Record<string, unknown>[] }> };
    rt.net.on(/api\.github\.com\/repos\/acme\/judged\/commits(?:\?|$)/, () => Response.json(gh.list));
    rt.net.on(/api\.github\.com\/repos\/acme\/judged\/commits\/[0-9a-f]+$/, (req) => Response.json(gh.commits[new URL(req.url).pathname.split("/").pop()!]));
    const tools = new JobTools(rt, inst, d, null);
    const listed = (await tools.call(step("read"), "github.read", { op: "commits", repo: "acme/judged", limit: 5 })) as { items: { sha: string; parents: number }[] };
    expect(listed.items.map((c) => [c.sha.slice(0, 7), c.parents])).toEqual([["99bd945", 2], ["67a6193", 1], ["5d2e3f0", 1], ["65dcc3a", 1], ["a40b9f6", 1]]);
    const harness = (await tools.call(step("read"), "github.read", { op: "commit", repo: "acme/judged", sha: gh.list[1]!.sha })) as { items: { filename: string; patch: string; cut: boolean }[] };
    const [file] = harness.items;
    expect(file!.cut).toBe(true);
    expect(file!.patch.length).toBeLessThanOrEqual(3000);
    expect(file!.patch).toMatch(/^@@ -0,0 \+1,206 @@\n\+\/\/ @vitest-environment node/);
    expect(file!.patch).toMatch(/\n\[\d+ lines not shown\]\n/);
    // Its end is there too: the file's last line.
    expect(file!.patch.endsWith("+});")).toBe(true);
    // A file GitHub left out (a generated snapshot of 8,129 lines) says so.
    const lessons = (await tools.call(step("read"), "github.read", { op: "commit", repo: "acme/judged", sha: gh.list[4]!.sha })) as { items: { filename: string; patch: string | null; cut: boolean }[] };
    expect(lessons.items.find((f) => f.filename.endsWith("0067_snapshot.json"))).toMatchObject({ patch: null, cut: true });
    expect(lessons.items.find((f) => f.filename.endsWith("lessons.ts"))).toMatchObject({ cut: true });
    expect(lessons.items.find((f) => f.filename.endsWith("0067_lesson_recipe.sql"))).toMatchObject({ cut: false });
  });

  it("adds the owner's key when they connected one, and never hands it back", async () => {
    await keep(rt, owner.id, "github", "GitHub (ada)", { token: GH_KEY });
    rt.net.on(/api\.github\.com\/repos\/acme\/private\/issues/, () => Response.json([{ number: 7, title: `leaked ${GH_KEY}`, user: { login: "ada" }, state: "open", labels: [{ name: "bug" }], html_url: "https://github.com/acme/private/issues/7", body: "x" }]));
    const tools = new JobTools(rt, inst, d, null);
    const got = await tools.call(step("read"), "github.read", { op: "issues", repo: "acme/private" });
    expect([...rt.net.calls].reverse().find((c) => c.url.host === "api.github.com")!.headers.get("authorization")).toBe(`Bearer ${GH_KEY}`);
    expect(JSON.stringify(got)).not.toContain(GH_KEY);
    expect(rt.logged.join("\n")).not.toContain(GH_KEY);
  });

  it("says plainly what a refusal or a missing repository means, and tries again later when the service is busy", async () => {
    rt.net.on(/acme\/gone/, () => Response.json({ message: "Not Found" }, { status: 404 }));
    rt.net.on(/acme\/busy/, () => Response.json({ message: "rate limited" }, { status: 429 }));
    const tools = new JobTools(rt, inst, d, null);
    await expect(tools.call(step("read"), "github.read", { op: "commits", repo: "acme/gone" })).rejects.toThrow("GitHub has no such item (404): check what the agent was given.");
    await expect(tools.call(step("read"), "github.read", { op: "commits", repo: "acme/busy" })).rejects.toBeInstanceOf(InfraError);
    await expect(tools.call(step("read"), "github.read", { op: "commits", repo: "not a repo" })).rejects.toThrow(/owner\/name/);
  });
});

describe("service.request and service.send", () => {
  it("reach only a service the agent says it uses", async () => {
    const tools = new JobTools(rt, inst, d, null);
    await expect(tools.call(step("read"), "service.request", { connection: "gitlab", path: "/projects" })).rejects.toThrow("This agent doesn't say it uses GitLab, so it can't reach it.");
    await expect(tools.call(step("read"), "service.request", { connection: "mastodon", path: "/x" })).rejects.toThrow(/isn't a service it can reach/);
  });

  it("read a feed's newest items", async () => {
    rt.net.on(/feeds\.example\.org/, () => new Response(`<?xml version="1.0"?><rss><channel><item><title>Release 2.0 &amp; more</title><link>https://example.org/2</link><pubDate>Sun, 15 Nov 2026 09:00:00 GMT</pubDate><description><![CDATA[<p>New things</p>]]></description></item></channel></rss>`, { headers: { "content-type": "application/rss+xml" } }));
    const tools = new JobTools(rt, inst, d, null);
    const got = (await tools.call(step("read"), "service.request", { connection: "rss", url: "https://feeds.example.org/blog.xml" })) as { status: number; data: { items: unknown[] } };
    expect(got.data.items).toEqual([{ title: "Release 2.0 & more", link: "https://example.org/2", published: "Sun, 15 Nov 2026 09:00:00 GMT", summary: "New things" }]);
  });

  it("only read: a body is a write, and a GraphQL mutation or a chain call that sends never goes", async () => {
    const tools = new JobTools(rt, inst, d, null);
    await expect(tools.call(step("read"), "service.request", { connection: "rss", url: "https://feeds.example.org/x", body: { a: 1 } })).rejects.toThrow(/only reads \(a GET\)/);
    const { writesIn } = await import("../agents/runtime/tools");
    expect(writesIn("graphql", { query: "mutation { issueCreate(input: {}) { success } }" })).toMatch(/mutation is a write/);
    expect(writesIn("graphql", { query: "{ viewer { name } }" })).toBeNull();
    expect(writesIn("jsonrpc", { jsonrpc: "2.0", method: "eth_sendRawTransaction", params: [] })).toMatch(/never made/);
    expect(writesIn("jsonrpc", { jsonrpc: "2.0", method: "eth_getBalance", params: [] })).toBeNull();
  });

  it("write only with the owner's switch on, to the connection's own address, keeping its secret", async () => {
    const tools = () => new JobTools(rt, inst, d, null);
    const post = { connection: "discord", body: { content: "3 new commits" } };
    // Not connected yet.
    await expect(tools().call(step("send"), "service.send", post, { answer: "Yes" })).rejects.toThrow("Discord isn't connected, so it can't be reached: connect it on Connections, then run it again.");
    await keep(rt, owner.id, "discord", "Discord (Builds)", { url: HOOK });
    // Connected, but a pasted key only reads until the owner says.
    await expect(tools().call(step("send"), "service.send", post, { answer: "Yes" })).rejects.toThrow("Writing to Discord is switched off on Connections, so nothing was written. Turn it on there to let your agents write.");
    await setWrites(rt, owner.id, "discord", true);
    rt.net.on(/discord\.com\/api\/webhooks/, () => new Response(null, { status: 204 }));
    const got = await tools().call(step("send"), "service.send", post, { answer: "Yes" });
    expect(got).toMatchObject({ status: 204 });
    const call = [...rt.net.calls].reverse().find((c) => c.url.host === "discord.com")!;
    expect(call.url.toString()).toBe(HOOK);
    expect(call.method).toBe("POST");
    expect(JSON.parse(call.body!)).toEqual({ content: "3 new commits" });
    expect(JSON.stringify(got)).not.toContain("discord-webhook-secret-token");
    // The write is in the audit log, never with its secret.
    const audit = await db.select().from(schema.agentAudit).where(eq(schema.agentAudit.installationId, inst.id));
    expect(audit.some((a) => a.tool === "service.send" && a.outcome === "ran")).toBe(true);
    expect(JSON.stringify(audit)).not.toContain("discord-webhook-secret-token");
  });
});

describe("the test bench", () => {
  it("answers each service call by its exact key, and notes the calls it had nothing for", async () => {
    const bench = emptyBench();
    bench.calls = { [callKey("github.read", { op: "commits", repo: "acme/widgets" })]: { items: [{ sha: "1" }] } };
    const mock = new MockTools(bench);
    expect(await mock.call("github.read", { repo: "acme/widgets", op: "commits" })).toEqual({ items: [{ sha: "1" }] });
    await expect(mock.call("github.read", { op: "commits", repo: "octocat/Hello-World" })).rejects.toBeInstanceOf(ToolError);
    expect(await mock.call("service.request", { connection: "dexscreener", path: "/latest/dex/search", query: { q: "eth" } })).toEqual({ status: 404, data: { message: "Not Found" } });
    expect(mock.missed).toEqual([callKey("github.read", { op: "commits", repo: "octocat/Hello-World" }), callKey("service.request", { connection: "dexscreener", path: "/latest/dex/search", query: { q: "eth" } })]);
  });

  it("treats what every service read brings in as untrusted", () => {
    for (const t of ["service.request", ...TYPED_READS.map((x) => x.tool)]) expect(OUTSIDE_TOOLS).toContain(t);
    expect(OUTSIDE_TOOLS).not.toContain("service.send");
  });
});

describe("each typed read", () => {
  it("belongs to a service of the catalog that lists it", () => {
    for (const t of TYPED_READS) expect(CATALOG.find((e) => e.id === t.service)?.tools, t.tool).toContain(t.tool);
  });

  it("shapes its service's answer flat", () => {
    const shape = (tool: string, data: unknown, args: unknown) => typedRead(tool)!.shape(data, args as never);
    expect(shape("coingecko.read", { bitcoin: { usd: 70000, usd_24h_change: -1.5, usd_market_cap: 1.4e12 } }, { coins: ["bitcoin"] })).toEqual({ prices: [{ coin: "bitcoin", price: 70000, change_24h: -1.5, market_cap: 1.4e12 }] });
    expect(shape("etherscan.read", { status: "1", result: [{ hash: "0x1", from: "0xa", to: "0xb", value: "1500000000000000000", timeStamp: "1763197200" }] }, { op: "transactions" })).toEqual({ items: [{ hash: "0x1", from: "0xa", to: "0xb", value: 1.5, token: "ETH", time: "2025-11-15T09:00:00.000Z" }] });
    expect(shape("tally.read", { questions: [{ id: "q1", title: "Project name" }], submissions: [{ id: "s1", submittedAt: "2026-11-15T09:00:00Z", responses: [{ questionId: "q1", value: "Tidewatch" }] }] }, {})).toEqual({ responses: [{ id: "s1", submittedAt: "2026-11-15T09:00:00Z", project_name: "Tidewatch" }] });
    expect(shape("notion.read", { results: [{ id: "p1", url: "https://notion.so/p1", last_edited_time: "t", properties: { Name: { type: "title", title: [{ plain_text: "Launch" }] }, "Due date": { type: "date", date: { start: "2026-12-01" } }, Tags: { type: "multi_select", multi_select: [{ name: "a" }, { name: "b" }] } } }] }, {})).toEqual({ pages: [{ id: "p1", url: "https://notion.so/p1", last_edited: "t", name: "Launch", due_date: "2026-12-01", tags: ["a", "b"] }] });
    expect(shape("stripe.read", { data: [{ id: "ch_1", amount: 1250, currency: "usd", status: "succeeded", created: 1763197200 }] }, { op: "charges" })).toMatchObject({ items: [{ id: "ch_1", amount: 12.5, currency: "usd", status: "succeeded", created: "2025-11-15T09:00:00.000Z" }] });
  });
});

describe("an incoming webhook", () => {
  it("gives the agent a private address whose posts start its jobs", async () => {
    const hooked = wire({ triggers: [{ kind: "webhook", description: "When the build server posts" }] });
    const p = await publishedAgent(db, owner, { definition: hooked, code: {} });
    const [row] = await db.insert(schema.agentInstallations).values({ agentId: p.agent.id, versionId: p.version.id, ownerUserId: owner.id, mocks: { sheets: {}, search: {}, wallet: { balanceUsdc: 0 } } }).returning();
    const url = (await hookUrl(rt, row!, hooked))!;
    expect(url).toMatch(/^https:\/\/boardofserv\.25th\.dev\/api\/hooks\/[A-Za-z0-9_-]{32}$/);
    const key = url.split("/").at(-1)!;
    const [stored] = await db.select().from(schema.agentInstallations).where(eq(schema.agentInstallations.id, row!.id));
    // Kept encrypted, found by a keyed hash: never readable from the table.
    expect(JSON.stringify(stored)).not.toContain(key);
    expect(await hookUrl(rt, stored!, hooked)).toBe(url);
    const posted = await takePost(rt, key, { build: "green" });
    expect(posted).toMatchObject({ started: true });
    const [job] = await db.select().from(schema.agentJobs).where(eq(schema.agentJobs.installationId, row!.id));
    expect(job!.trigger).toMatchObject({ kind: "webhook", body: { build: "green" } });
    expect(await takePost(rt, "x".repeat(32), {})).toEqual({ refused: { status: 404, error: "There's no such address." } });
    // An agent that doesn't start on a post has no address.
    expect(await hookUrl(rt, inst, d)).toBeNull();
  });
});

describe("a long text's first and last lines", () => {
  it("keeps the start and the end within the room, and says how many lines are left out", () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
    const kept = headTail(text, 300);
    expect(kept.length).toBeLessThanOrEqual(300);
    expect(kept.startsWith("line 1\nline 2\n")).toBe(true);
    expect(kept.endsWith("line 99\nline 100")).toBe(true);
    const hidden = Number(/\[(\d+) lines not shown\]/.exec(kept)![1]);
    expect(kept.split("\n").length - 1 + hidden).toBe(100);
    expect(headTail("short", 300)).toBe("short");
  });
});
