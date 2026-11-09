// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fakeNet } from "@/test/fakeNet";
import { fakeReppo } from "@/test/fakeReppo";
import { evaluate, nextPollMs, readEval, readResult, reppoFrom, ReppoError, REPPO_URL, submitEval } from "./client";

// Reppo's client: the shape its docs give, a time limit on every call,
// retries only after a network failure (and a submission never after a
// time limit, when Reppo may have it already), the key only ever sent to
// Reppo's own address.

const cfg = { apiKey: "test-reppo-key", baseUrl: REPPO_URL };
const noWait = async () => undefined;

const hanging = (async (_url: string, init: RequestInit) =>
  new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch;

describe("Reppo's client", () => {
  it("submits, reads back until completed, and reads the result's fields", async () => {
    const net = fakeNet();
    const r = fakeReppo(net);
    r.verdict = () => ({ score: 74, route: "review", reason: `It asked first ${String.fromCharCode(0x2014)} good, but the summary was thin.`, rubric: { accuracy: 70, safety: 90 } });
    const e = await evaluate(cfg, { taskType: "action", input: "What the renter asked for: a restock." }, { fetchImpl: net.fetch, sleep: noWait });
    expect(e).toMatchObject({ status: "COMPLETED", score: 74, route: "review", decision: "accept", confidence: "medium", rubric: { accuracy: 70, safety: 90 }, creditsCharged: 440 });
    expect(r.submitted).toEqual([{ taskType: "action", input: "What the renter asked for: a restock.", auth: "Bearer test-reppo-key" }]);
    // Every call went to Reppo, and only there.
    expect(new Set(net.calls.map((c) => c.url.origin))).toEqual(new Set([REPPO_URL]));
  });

  it("reads an answer defensively, and refuses one with no id or status", () => {
    expect(readEval({ id: "ev_1", status: "QUEUED", score: null, route: null, result: null })).toMatchObject({ id: "ev_1", status: "QUEUED", score: null, route: null, rubric: {} });
    const odd = readEval({ id: "ev_2", status: "COMPLETED", creditsCharged: 440, result: { score: 140, route: "launch", decision: "maybe", rubric_scores: { ok: 50, "<script>": 99, n: "x" } } });
    expect(odd).toMatchObject({ score: 100, route: null, decision: null, rubric: { ok: 50 } });
    for (const bad of [null, {}, { id: "x" }, { id: "x", status: "DONE" }]) expect(() => readEval(bad)).toThrow(ReppoError);
  });

  it("names Reppo's refusals: key, credits, request, unknown id, down", async () => {
    const net = fakeNet();
    const r = fakeReppo(net);
    const kinds: string[] = [];
    for (const status of [400, 401, 402, 500, 502]) {
      r.submitStatus = status;
      kinds.push(((await submitEval(cfg, { taskType: "action", input: "x" }, { fetchImpl: net.fetch }).catch((e: unknown) => e)) as ReppoError).kind);
    }
    expect(kinds).toEqual(["bad_request", "auth", "credits", "unavailable", "unavailable"]);
    expect(((await readResult(cfg, "ev_nope", { fetchImpl: net.fetch }).catch((e: unknown) => e)) as ReppoError).kind).toBe("not_found");
    expect(((await submitEval({ ...cfg, apiKey: "wrong" }, { taskType: "action", input: "x" }, { fetchImpl: net.fetch }).catch((e: unknown) => e)) as ReppoError).kind).toBe("auth");
  });

  it("checks the input before sending it: not empty, not over 50 KB, and ids are ids", async () => {
    const net = fakeNet();
    fakeReppo(net);
    for (const input of ["   ", "x".repeat(50_001)]) {
      expect(((await submitEval(cfg, { taskType: "action", input }, { fetchImpl: net.fetch }).catch((e: unknown) => e)) as ReppoError).kind).toBe("bad_request");
    }
    expect(((await readResult(cfg, "../../admin", { fetchImpl: net.fetch }).catch((e: unknown) => e)) as ReppoError).kind).toBe("bad_request");
    expect(net.calls).toEqual([]);
  });

  it("gives up after its time limit, and doesn't repeat a submission that timed out", async () => {
    let tries = 0;
    const counting = (async (url: string, init: RequestInit) => {
      tries += 1;
      return hanging(url, init);
    }) as typeof fetch;
    const e = (await submitEval(cfg, { taskType: "action", input: "x" }, { fetchImpl: counting, timeoutMs: 30, retries: 3, sleep: noWait }).catch((x: unknown) => x)) as ReppoError;
    expect(e.kind).toBe("timeout");
    expect(tries).toBe(1);
    // A read is safe to repeat.
    tries = 0;
    const r = (await readResult(cfg, "ev_1", { fetchImpl: counting, timeoutMs: 30, retries: 2, sleep: noWait }).catch((x: unknown) => x)) as ReppoError;
    expect(r.kind).toBe("timeout");
    expect(tries).toBe(3);
  });

  it("retries a network failure, and only that", async () => {
    const net = fakeNet();
    const r = fakeReppo(net);
    let fails = 2;
    const flaky = (async (url: string, init: RequestInit) => {
      if (fails-- > 0) throw new TypeError("fetch failed");
      return net.fetch(url, init);
    }) as typeof fetch;
    expect((await submitEval(cfg, { taskType: "action", input: "x" }, { fetchImpl: flaky, retries: 2, sleep: noWait })).status).toBe("QUEUED");
    // An answer from Reppo isn't retried.
    r.submitStatus = 500;
    const before = net.calls.length;
    await submitEval(cfg, { taskType: "action", input: "x" }, { fetchImpl: net.fetch, retries: 3, sleep: noWait }).catch(() => null);
    expect(net.calls.length - before).toBe(1);
    r.down = true;
    expect(((await submitEval(cfg, { taskType: "action", input: "x" }, { fetchImpl: net.fetch, retries: 1, sleep: noWait }).catch((x: unknown) => x)) as ReppoError).kind).toBe("network");
  });

  it("is off without a key, and sends the key to Reppo's own address only", () => {
    expect(reppoFrom({})).toBeNull();
    expect(reppoFrom({ REPPO_API_KEY: "  " })).toBeNull();
    expect(reppoFrom({ REPPO_API_KEY: "k" })).toEqual({ apiKey: "k", baseUrl: REPPO_URL });
    expect(reppoFrom({ REPPO_API_KEY: "k", REPPO_BASE_URL: "https://staging.eval.reppo.xyz/" })!.baseUrl).toBe("https://staging.eval.reppo.xyz");
    for (const elsewhere of ["https://evil.example", "http://eval.reppo.xyz", "https://eval.reppo.xyz.evil.example", "https://reppo.xyz@evil.example"]) {
      expect(reppoFrom({ REPPO_API_KEY: "k", REPPO_BASE_URL: elsewhere })!.baseUrl, elsewhere).toBe(REPPO_URL);
    }
  });

  it("looks again often across 30 to 90 seconds, then less often", () => {
    const at: number[] = [];
    let t = 0;
    for (let i = 0; i < 6; i++) at.push((t += nextPollMs(i)));
    expect(at[0]).toBe(30_000);
    expect(at.filter((x) => x <= 90_000).length).toBeGreaterThanOrEqual(4);
    expect(nextPollMs(40)).toBe(300_000);
  });
});
