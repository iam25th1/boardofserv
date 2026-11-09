// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { installed, publishedAgent, testRuntime, type TestRuntime } from "@/test/runtimeFixtures";
import { fakeReppo, type FakeReppo } from "@/test/fakeReppo";
import { enqueue } from "@/lib/agents/runtime/jobs";
import { jobWorker } from "@/lib/agents/runtime/worker";
import { credits, GIVE_UP_MS, MAX_ATTEMPTS, PAUSE_MS, pollDue, queueEval, submitDue, type NewEval } from "./evals";

// Reppo's evaluations in the background: queued once per thing, submitted,
// read back with growing gaps, and recorded with the credits charged. Reppo
// slow, down, out of credits or refusing the key never touches a job: the
// failure is recorded and tried again later, within limits.

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let rt: TestRuntime;
let reppo: FakeReppo;
let owner: schema.User;
let base: Omit<NewEval, "key" | "input">;

beforeAll(async () => {
  ({ client, db } = await testDb());
  owner = await addUser(db, "reppo.owner");
  const rt0 = testRuntime(db);
  const p = await publishedAgent(db, owner);
  const inst = await installed(rt0, owner, p);
  base = { kind: "job", agentId: p.agent.id, versionId: p.version.id, installationId: inst.id, taskType: "action" };
});
afterAll(async () => client.close());
beforeEach(async () => {
  await db.delete(schema.reppoEvals);
  rt = testRuntime(db);
  reppo = fakeReppo(rt.net);
});

const rowOf = async (key: string) => (await db.select().from(schema.reppoEvals).where(eq(schema.reppoEvals.key, key)))[0]!;
const move = (ms: number) => rt.clock.move(ms);

describe("Reppo's evaluations", () => {
  it("are queued once per thing, so nothing is scored twice", async () => {
    expect(await queueEval(rt, { ...base, key: "job:1", input: "a" })).not.toBeNull();
    expect(await queueEval(rt, { ...base, key: "job:1", input: "a again" })).toBeNull();
    await submitDue(rt);
    await submitDue(rt);
    expect(reppo.submitted).toHaveLength(1);
  });

  it("are submitted, read back from 30 seconds on, and recorded with their credits", async () => {
    reppo.readsToFinish = 3;
    await queueEval(rt, { ...base, key: "job:2", input: "What it was for: a restock." });
    expect(await submitDue(rt)).toBe(1);
    expect(await rowOf("job:2")).toMatchObject({ status: "submitted", reppoId: "ev_000001" });
    // Not read before 30 seconds.
    move(29_000);
    expect(await pollDue(rt)).toBe(0);
    expect(reppo.reads).toBe(0);
    for (let i = 0; i < 4; i++) {
      move(31_000);
      await pollDue(rt);
    }
    expect(await rowOf("job:2")).toMatchObject({ status: "completed", score: 82, route: "ship", decision: "accept", creditsCharged: 440 });
    expect(reppo.reads).toBe(3);
    expect(await credits(rt, new Date(0))).toEqual({ charged: 440, evals: 1, inFlight: 0, reserved: 0 });
  });

  it("keep no em dash from Reppo's reason", async () => {
    reppo.verdict = () => ({ score: 50, route: "review", reason: `It asked ${String.fromCharCode(0x2014)} but late.` });
    reppo.readsToFinish = 1;
    await queueEval(rt, { ...base, key: "job:3", input: "x" });
    await submitDue(rt);
    move(31_000);
    await pollDue(rt);
    expect((await rowOf("job:3")).reason).toBe("It asked, but late.");
  });

  it("go again when Reppo fails one (not charged), a few times at most", async () => {
    reppo.readsToFinish = 1;
    reppo.failNext = 1;
    await queueEval(rt, { ...base, key: "job:4", input: "x" });
    await submitDue(rt);
    move(31_000);
    await pollDue(rt);
    expect(await rowOf("job:4")).toMatchObject({ status: "queued", attempts: 1, reppoId: null });
    move(61_000);
    await submitDue(rt);
    move(31_000);
    await pollDue(rt);
    expect(await rowOf("job:4")).toMatchObject({ status: "completed", attempts: 1 });
    expect(reppo.submitted).toHaveLength(2);
  });

  it("wait an hour, sending nothing, when Reppo refuses the key or the credits run out", async () => {
    for (const status of [402, 401]) {
      await db.delete(schema.reppoEvals);
      reppo.submitStatus = status;
      await queueEval(rt, { ...base, key: `job:${status}`, input: "x" });
      await queueEval(rt, { ...base, key: `job:${status}b`, input: "y" });
      expect(await submitDue(rt)).toBe(0);
      const row = await rowOf(`job:${status}`);
      expect(row.status).toBe("queued");
      expect(row.attempts).toBe(0);
      expect(row.lastError).toMatch(status === 402 ? /^credits:/ : /^auth:/);
      reppo.submitStatus = null;
      move(10 * 60_000);
      expect(await submitDue(rt)).toBe(0);
      move(PAUSE_MS);
      expect(await submitDue(rt)).toBe(2);
    }
  });

  it("try again later when Reppo is down, and give up after a few tries", async () => {
    reppo.down = true;
    await queueEval(rt, { ...base, key: "job:5", input: "x" });
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await submitDue(rt, { call: { sleep: async () => undefined } });
      move(2 * 60 * 60_000);
    }
    expect(await rowOf("job:5")).toMatchObject({ status: "failed", attempts: MAX_ATTEMPTS });
    expect((await rowOf("job:5")).lastError).toMatch(/^network:/);
  });

  it("are given up when no result comes in hours, and a lost one isn't read forever", async () => {
    reppo.readsToFinish = 1_000;
    await queueEval(rt, { ...base, key: "job:6", input: "x" });
    await submitDue(rt);
    for (let t = 0; t < GIVE_UP_MS + 10 * 60_000; t += 10 * 60_000) {
      move(10 * 60_000);
      await pollDue(rt);
    }
    expect(await rowOf("job:6")).toMatchObject({ status: "failed", lastError: "timeout: no result in 6 hours" });
    // Reppo forgetting one: failed at once.
    await queueEval(rt, { ...base, key: "job:7", input: "x" });
    await submitDue(rt);
    reppo.evals.clear();
    move(31_000);
    await pollDue(rt);
    expect((await rowOf("job:7")).status).toBe("failed");
  });

  it("never hold up a job: the worker runs jobs while Reppo hangs", async () => {
    // Reppo answers nothing, ever.
    rt.net.on("https://eval.reppo.xyz/", () => new Promise<Response>(() => undefined));
    await queueEval(rt, { ...base, key: "job:8", input: "x" });
    await db.update(schema.agentJobs).set({ status: "cancelled" }).where(eq(schema.agentJobs.status, "queued"));
    const inst = await installed(rt, owner, await publishedAgent(db, owner));
    rt.serve = (ids) => (ids.includes("within") ? "within" : ids[0]!);
    const job = await enqueue(rt, inst, { kind: "manual" });
    const worker = jobWorker(rt);
    await worker.cycle();
    // The job runs to its end; Reppo's call is still waiting.
    const running = worker.running();
    await Promise.race([Promise.all(running.slice(0, -1)), new Promise((r) => setTimeout(r, 5_000))]);
    worker.stop();
    const [j] = await db.select().from(schema.agentJobs).where(eq(schema.agentJobs.id, job.id));
    expect(j!.status).toBe("done");
    expect((await rowOf("job:8")).status).toBe("queued");
  });
});
