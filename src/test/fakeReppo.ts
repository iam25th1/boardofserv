import type { FakeNet, NetRequest } from "./fakeNet";

// Reppo's Eval Router as tests see it, answering in the shape its docs give
// (https://eval.reppo.xyz/agents.md, sections 3 and 4): a submission comes
// back 201 QUEUED with an id; reading it back answers PROCESSING a few
// times, then COMPLETED with a score, a route and a result, charging 440
// credits. Every submission is kept with the authorization it carried.

type Route = "ship" | "review" | "block";

export interface FakeEval {
  id: string;
  taskType: string;
  input: string;
  reads: number;
  status: "QUEUED" | "PROCESSING" | "COMPLETED" | "FAILED";
}

export interface FakeReppo {
  submitted: { taskType: string; input: string; auth: string | null }[];
  reads: number;
  evals: Map<string, FakeEval>;
  // How each input is scored.
  verdict: (input: string) => { score: number; route: Route; reason: string; rubric?: Record<string, number> };
  // Reads before an evaluation completes.
  readsToFinish: number;
  // Reppo answering a submission or a read with this status instead.
  submitStatus: number | null;
  readStatus: number | null;
  // The next evaluations come back FAILED (not charged).
  failNext: number;
  // The network is down: every call throws.
  down: boolean;
  // A submission whose connection drops after Reppo took it.
  dropAfterSubmit: boolean;
  balance: number;
}

const iso = (n: number) => new Date(Date.UTC(2026, 10, 9, 12, 0, n)).toISOString();

function shape(e: FakeEval, r: ReturnType<FakeReppo["verdict"]> | null) {
  const done = e.status === "COMPLETED";
  return {
    id: e.id,
    taskType: e.taskType,
    source: "API",
    input: e.input,
    status: e.status,
    score: done ? r!.score : null,
    route: done ? r!.route : null,
    creditsCharged: done ? 440 : 0,
    createdAt: iso(0),
    startedAt: e.status === "QUEUED" ? null : iso(2),
    completedAt: done ? iso(58) : null,
    attachments: [],
    result: done
      ? {
          score: r!.score,
          decision: r!.score >= 60 ? "accept" : "reject",
          confidence: "medium",
          route: r!.route,
          reason: r!.reason,
          rubric_scores: r!.rubric ?? { helpfulness: r!.score, safety: Math.min(100, r!.score + 5) },
          consensus: { method: "median" },
          gates: [],
          explain: { confidence_checks: [], route_reasons: [r!.reason] },
        }
      : null,
    trace: done ? { evaluators: [] } : null,
    error: e.status === "FAILED" ? "Evaluator panel unavailable." : null,
  };
}

export function fakeReppo(net: FakeNet, base = "https://eval.reppo.xyz"): FakeReppo {
  let n = 0;
  const r: FakeReppo = {
    submitted: [],
    reads: 0,
    evals: new Map(),
    verdict: () => ({ score: 82, route: "ship", reason: "The agent did what its purpose says, and asked before it acted." }),
    readsToFinish: 2,
    submitStatus: null,
    readStatus: null,
    failNext: 0,
    down: false,
    dropAfterSubmit: false,
    balance: 22_000,
  };
  const reply = (status: number, body: unknown) => Response.json(body, { status });
  net.on(`${base}/api/v1/agents/evals`, (req: NetRequest) => {
    if (r.down) throw new TypeError("fetch failed");
    const auth = req.headers.get("authorization");
    if (auth !== "Bearer test-reppo-key") return reply(401, { error: "Unauthorized" });
    if (req.method === "POST" && req.url.pathname === "/api/v1/agents/evals") {
      if (r.submitStatus) return reply(r.submitStatus, { error: `status ${r.submitStatus}` });
      const body = req.json() as { taskType?: string; input?: string };
      if (!body.taskType || !["claim", "response", "action"].includes(body.taskType) || !body.input) return reply(400, { error: "Invalid body" });
      if (r.balance < 440) return reply(402, { error: "Insufficient credits" });
      const e: FakeEval = { id: `ev_${String(++n).padStart(6, "0")}`, taskType: body.taskType, input: body.input, reads: 0, status: "QUEUED" };
      r.evals.set(e.id, e);
      r.submitted.push({ taskType: body.taskType, input: body.input, auth });
      if (r.dropAfterSubmit) throw new TypeError("fetch failed");
      return reply(201, shape(e, null));
    }
    const id = decodeURIComponent(req.url.pathname.split("/").pop() ?? "");
    const e = r.evals.get(id);
    r.reads += 1;
    if (r.readStatus) return reply(r.readStatus, { error: `status ${r.readStatus}` });
    if (!e) return reply(404, { error: "Not found" });
    if (e.status === "QUEUED" || e.status === "PROCESSING") {
      e.reads += 1;
      if (e.reads >= r.readsToFinish) {
        if (r.failNext > 0) {
          r.failNext -= 1;
          e.status = "FAILED";
        } else {
          e.status = "COMPLETED";
          r.balance -= 440;
        }
      } else e.status = "PROCESSING";
    }
    return reply(200, shape(e, e.status === "COMPLETED" ? r.verdict(e.input) : null));
  });
  return r;
}
