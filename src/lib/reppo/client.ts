import "server-only";

// Reppo's Eval Router (https://eval.reppo.xyz/agents.md): an evaluation is
// submitted (POST /api/v1/agents/evals with a task type and a text input)
// and comes back queued with an id; a panel of evaluators scores it in the
// background, usually within 30 to 90 seconds, and it is read back
// (GET /api/v1/agents/evals/{id}) until it is COMPLETED or FAILED. A text
// evaluation costs 440 credits, charged only once it completes. Every call
// carries the API key as a bearer token, to Reppo's own address and nowhere
// else.
//
// This client has a time limit on every call and retries only when the
// network failed (never on an answer Reppo gave). It never decides
// anything: what it brings back is a second opinion for people to read.

export const REPPO_URL = "https://eval.reppo.xyz";
export const EVAL_CREDITS = 440;
export const MAX_INPUT_BYTES = 50_000;

export type TaskType = "claim" | "response" | "action";
export type Route = "ship" | "review" | "block";
export type EvalStatus = "QUEUED" | "PROCESSING" | "COMPLETED" | "FAILED";

export interface ReppoConfig {
  apiKey: string;
  baseUrl: string;
}

export function reppoFrom(env: Record<string, string | undefined> = process.env): ReppoConfig | null {
  const apiKey = env.REPPO_API_KEY?.trim();
  if (!apiKey) return null;
  // Reppo's own address only: a custom base must still be https on reppo.xyz.
  const base = (env.REPPO_BASE_URL?.trim() || REPPO_URL).replace(/\/+$/, "");
  const ok = /^https:\/\/([a-z0-9-]+\.)*reppo\.xyz$/i.test(base);
  return { apiKey, baseUrl: ok ? base : REPPO_URL };
}

export interface EvalResult {
  id: string;
  status: EvalStatus;
  score: number | null;
  route: Route | null;
  decision: "accept" | "reject" | null;
  confidence: "low" | "medium" | "high" | null;
  reason: string | null;
  rubric: Record<string, number>;
  creditsCharged: number;
  error: string | null;
}

export type ReppoErrorKind = "auth" | "credits" | "bad_request" | "not_found" | "unavailable" | "network" | "timeout" | "bad_reply";

export class ReppoError extends Error {
  constructor(
    message: string,
    readonly kind: ReppoErrorKind,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "ReppoError";
  }
}

const STATUSES: EvalStatus[] = ["QUEUED", "PROCESSING", "COMPLETED", "FAILED"];
const ROUTES: Route[] = ["ship", "review", "block"];
const pick = <T extends string>(v: unknown, of: readonly T[]): T | null => (typeof v === "string" && (of as readonly string[]).includes(v) ? (v as T) : null);

// An evaluation as Reppo returns it, read defensively: anything missing or
// of the wrong type is left out rather than trusted.
export function readEval(body: unknown): EvalResult {
  const b = (body ?? {}) as Record<string, unknown>;
  const r = (b.result ?? {}) as Record<string, unknown>;
  const id = typeof b.id === "string" && b.id ? b.id : null;
  const status = pick(b.status, STATUSES);
  if (!id || !status) throw new ReppoError("Reppo's answer didn't have an evaluation id and status.", "bad_reply");
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : null);
  const rubric: Record<string, number> = {};
  if (r.rubric_scores && typeof r.rubric_scores === "object") {
    for (const [k, v] of Object.entries(r.rubric_scores as Record<string, unknown>).slice(0, 12)) {
      const n = num(v);
      if (n !== null && /^[\w .-]{1,40}$/.test(k)) rubric[k] = n;
    }
  }
  return {
    id,
    status,
    score: num(r.score ?? b.score),
    route: pick(r.route ?? b.route, ROUTES),
    decision: pick(r.decision, ["accept", "reject"] as const),
    confidence: pick(r.confidence, ["low", "medium", "high"] as const),
    reason: typeof r.reason === "string" ? r.reason.slice(0, 2000) : null,
    rubric,
    creditsCharged: typeof b.creditsCharged === "number" && b.creditsCharged > 0 ? Math.round(b.creditsCharged) : 0,
    error: typeof b.error === "string" ? b.error.slice(0, 300) : null,
  };
}

export interface CallOptions {
  fetchImpl?: typeof fetch;
  // Each call's time limit.
  timeoutMs?: number;
  // Tries again after a network failure, this many times.
  retries?: number;
  // Waits between tries (tests pass one that doesn't wait).
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// A network failure before any answer is worth another try. A read can
// always be repeated; a submission only when the connection failed, never
// after a time limit, when Reppo may have taken it already (Reppo has no
// idempotency key, so a second one would be scored and charged again).
function networkFailure(err: unknown, repeatable: boolean): boolean {
  if (!(err instanceof Error)) return false;
  const timedOut = err.name === "AbortError" || err.name === "TimeoutError";
  if (timedOut) return repeatable;
  return err.name === "TypeError" || /fetch failed|network|ECONN|ENOTFOUND|EAI_AGAIN|socket/i.test(err.message);
}

async function call(cfg: ReppoConfig, path: string, init: RequestInit, o: CallOptions): Promise<unknown> {
  const repeatable = (init.method ?? "GET") === "GET";
  const doFetch = o.fetchImpl ?? fetch;
  const tries = 1 + Math.max(0, o.retries ?? 2);
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await doFetch(`${cfg.baseUrl}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${cfg.apiKey}`, accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) },
        signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
      });
    } catch (err) {
      if (networkFailure(err, repeatable) && attempt < tries) {
        await (o.sleep ?? wait)(500 * 2 ** (attempt - 1));
        continue;
      }
      const timedOut = err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
      throw new ReppoError(timedOut ? "Reppo didn't answer in time." : "Reppo couldn't be reached.", timedOut ? "timeout" : "network");
    }
    if (res.ok) {
      try {
        return await res.json();
      } catch {
        throw new ReppoError("Reppo's answer wasn't JSON.", "bad_reply", res.status);
      }
    }
    const s = res.status;
    if (s === 401) throw new ReppoError("Reppo refused the API key.", "auth", s);
    if (s === 402) throw new ReppoError("Reppo's credits are used up.", "credits", s);
    if (s === 400) throw new ReppoError("Reppo refused the evaluation's request.", "bad_request", s);
    if (s === 404) throw new ReppoError("Reppo has no such evaluation.", "not_found", s);
    throw new ReppoError(`Reppo answered ${s}.`, "unavailable", s);
  }
}

export async function submitEval(cfg: ReppoConfig, body: { taskType: TaskType; input: string }, o: CallOptions = {}): Promise<EvalResult> {
  const input = body.input.trim();
  if (!input) throw new ReppoError("There's nothing to evaluate.", "bad_request");
  if (Buffer.byteLength(input, "utf8") > MAX_INPUT_BYTES) throw new ReppoError("The evaluation's input is over 50 KB.", "bad_request");
  return readEval(await call(cfg, "/api/v1/agents/evals", { method: "POST", body: JSON.stringify({ taskType: body.taskType, input }) }, o));
}

export async function readResult(cfg: ReppoConfig, id: string, o: CallOptions = {}): Promise<EvalResult> {
  if (!/^[\w-]{1,100}$/.test(id)) throw new ReppoError("That isn't an evaluation id.", "bad_request");
  return readEval(await call(cfg, `/api/v1/agents/evals/${encodeURIComponent(id)}`, { method: "GET" }, o));
}

// When to look again at an evaluation, by how many looks it has had: not
// before 30 seconds, then often across the usual 30 to 90 seconds, then
// less and less often.
export function nextPollMs(polls: number): number {
  const steps = [30_000, 10_000, 10_000, 15_000, 15_000, 20_000, 30_000, 60_000, 120_000];
  return steps[polls] ?? 300_000;
}

// Submits, then reads it back until it is done or the time is up (scripts
// and live checks; the worker polls across cycles instead).
export async function evaluate(cfg: ReppoConfig, body: { taskType: TaskType; input: string }, o: CallOptions & { deadlineMs?: number } = {}): Promise<EvalResult & { ms: number }> {
  const t0 = Date.now();
  let e = await submitEval(cfg, body, o);
  for (let polls = 0; e.status !== "COMPLETED" && e.status !== "FAILED"; polls++) {
    if (Date.now() - t0 > (o.deadlineMs ?? 240_000)) break;
    await (o.sleep ?? wait)(Math.min(nextPollMs(polls), 15_000));
    e = await readResult(cfg, e.id, o);
  }
  return { ...e, ms: Date.now() - t0 };
}
