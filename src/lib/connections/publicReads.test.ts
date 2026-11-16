// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { publishedAgent, testRuntime, type TestRuntime } from "@/test/runtimeFixtures";
import { checkDefinition, type AgentDefinition } from "../agents/definition";
import { JobTools } from "../agents/runtime/tools";
import { InfraError } from "../agents/runner";
import { forgetPublicReads } from "./publicReads";
import { keep } from "./vault";

// GitHub without a key: every agent on the server without its owner's own
// GitHub connection shares 60 public reads an hour. The owner's own key is
// used whenever they connected one; without one, a read is answered from
// what was read within ten minutes, and when the shared reads run low or
// out the owner is told, in plain words, to connect GitHub.

const d: AgentDefinition = (() => {
  const c = checkDefinition({
    format: 1,
    name: "Repo watch",
    job: { does: "Reads new commits and tells the owner.", done: "Told." },
    triggers: [{ kind: "schedule", every: "day", at: "09:00", description: "Every day at 9" }],
    settings: [{ key: "repos", label: "Repositories", type: "list", help: "owner/name", choices: [] }],
    rules: [],
    memory: [],
    steps: [
      { id: "read", kind: "code", title: "Read commits", description: "Read the commits of settings.repos with github.read and return message.", inputs: ["settings"], outputs: ["message"], tools: ["github.read"], next: "send" },
      { id: "send", kind: "action", title: "Tell the owner", action: "tell", inputs: ["message"], outputs: [], next: null },
    ],
    actions: [{ id: "tell", tool: "telegram.send", description: "Tell the owner" }],
    limits: { maxSteps: 20, maxRunSeconds: 60, maxSpendUsd: 0.1 },
  });
  if (!c.ok) throw new Error(c.errors.join("; "));
  return c.definition;
})();

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let rt: TestRuntime;

beforeAll(async () => {
  ({ client, db } = await testDb());
  rt = testRuntime(db);
});
beforeEach(() => forgetPublicReads());
afterAll(async () => client.close());

// An owner with the repo watch installed, and GitHub's answer with what is
// left of the shared allowance.
async function owner(name: string) {
  const u = await addUser(db, name);
  const p = await publishedAgent(db, u, { definition: d, code: {} });
  const [inst] = await db.insert(schema.agentInstallations).values({ agentId: p.agent.id, versionId: p.version.id, ownerUserId: u.id, mocks: { sheets: {}, search: {}, wallet: { balanceUsdc: 0 } }, timezone: "UTC" }).returning();
  return { u, inst: inst!, tools: new JobTools(rt, inst!, d, null) };
}
const commits = [{ sha: "abc1234", html_url: "https://github.com/acme/widgets/commit/abc1234", commit: { message: "Fix it", author: { name: "Ada", date: "2026-11-09T05:00:00Z" } } }];
const resetIn = (seconds: number) => String(Math.floor(rt.now().getTime() / 1000) + seconds);
const github = (path: RegExp, remaining: number, o: { status?: number; body?: unknown } = {}) =>
  rt.net.on(path, () => Response.json(o.body ?? commits, { status: o.status ?? 200, headers: { "x-ratelimit-remaining": String(remaining), "x-ratelimit-reset": resetIn(1800) } }));
const step = d.steps[0]!;
const reads = (repo: string) => rt.net.calls.filter((c) => c.url.pathname === `/repos/${repo}/commits`);
const told = async (installationId: string) => (await db.select().from(schema.agentMessages).where(eq(schema.agentMessages.installationId, installationId))).map((m) => m.text);

describe("reading GitHub", () => {
  it("uses the owner's own GitHub connection whenever there is one, never the shared reads", async () => {
    const { u, inst, tools } = await owner("public.own");
    await keep(rt, u.id, "github", "GitHub (ada)", { token: "github_pat_test_own_key_0001" }); // gitleaks:allow (a made-up key the test plants)
    github(/\/repos\/acme\/own\/commits/, 3);
    await tools.call(step, "github.read", { op: "commits", repo: "acme/own" });
    await tools.call(step, "github.read", { op: "commits", repo: "acme/own" });
    expect(reads("acme/own").map((c) => c.headers.get("authorization"))).toEqual(["Bearer github_pat_test_own_key_0001", "Bearer github_pat_test_own_key_0001"]);
    expect(await told(inst.id)).toEqual([]);
  });

  it("answers the same public read from what it read within ten minutes", async () => {
    const { tools } = await owner("public.cache");
    github(/\/repos\/acme\/cached\/commits/, 50);
    const first = await tools.call(step, "github.read", { op: "commits", repo: "acme/cached" });
    expect(await tools.call(step, "github.read", { op: "commits", repo: "acme/cached" })).toEqual(first);
    expect(reads("acme/cached")).toHaveLength(1);
    expect(reads("acme/cached")[0]!.headers.get("authorization")).toBeNull();
    rt.clock.move(11 * 60_000);
    await tools.call(step, "github.read", { op: "commits", repo: "acme/cached" });
    expect(reads("acme/cached")).toHaveLength(2);
  });

  it("tells the owner once, in plain words, when the shared reads run low", async () => {
    const { inst, tools } = await owner("public.low");
    github(/\/repos\/acme\/low\/commits/, 5);
    github(/\/repos\/acme\/lower\/commits/, 4);
    await tools.call(step, "github.read", { op: "commits", repo: "acme/low" });
    await tools.call(step, "github.read", { op: "commits", repo: "acme/lower" });
    const said = await told(inst.id);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/^Repo watch reads GitHub without your own key, so it shares this server's free GitHub reads with every other agent here, and only 5 are left until \d\d:\d\d\. Connect GitHub on Connections with a free read-only token \(read access to the repositories it checks\), and it reads with your own allowance instead\.$/);
  });

  it("waits when they are used up, saying why, and reads nothing more until they come back", async () => {
    const { inst, tools } = await owner("public.out");
    github(/\/repos\/acme\/out\/commits/, 0, { status: 403, body: { message: "API rate limit exceeded for 203.0.113.9." } });
    const err = await tools.call(step, "github.read", { op: "commits", repo: "acme/out" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InfraError);
    expect((err as Error).message).toMatch(/^This server's free GitHub reads are used up until \d\d:\d\d, so it tries again then\. Connect GitHub on Connections with a free read-only token, and it reads with your own allowance instead\.$/);
    expect((await told(inst.id))[0]).toMatch(/and they are used up until \d\d:\d\d, so it waits until then\. Connect GitHub on Connections/);
    // Another read waits too, without asking GitHub.
    const before = rt.net.calls.length;
    await expect(tools.call(step, "github.read", { op: "commits", repo: "acme/other" })).rejects.toBeInstanceOf(InfraError);
    expect(rt.net.calls.length).toBe(before);
    expect(await told(inst.id)).toHaveLength(1);
  });
});
