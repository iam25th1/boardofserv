import type { PgliteDatabase } from "drizzle-orm/pglite";
import type * as schema from "@/lib/db/schema";
import { jobFor } from "@/lib/agents/build";
import { stepDepths, stepLine, stepsInOrder } from "@/lib/agents/plainView";
import { draftOf } from "@/lib/agents/store";
import { describedEnough } from "@/lib/sketchFields";
import type { AgentBuilderDTO, SketchDTO } from "@/lib/types";
import type { Ledger } from "./live";
import type { SuiteRequest } from "./requests";

// One request taken through the journey a maker takes in the chat, through
// the real routes: chat turns until the chat has what it needs (the
// maker's answers from the suite, one a turn), Make it, Looks right once
// the steps are shown, then the build and its self test. Where it got to,
// in the stages the chat shows: 1 Describe, 2 Steps, 3 Build, 4 Try it.

export interface JourneyResult {
  id: string;
  name: string;
  // The last stage it reached, and whether its test passed there.
  stage: 1 | 2 | 3 | 4;
  passed: boolean;
  // Why it stopped, in one line, when it didn't pass.
  failure: string | null;
  // Make it came under a reply.
  offered?: boolean;
  turns: { said: string; reply: string; sketch: Partial<SketchDTO> | null }[];
  plan: string[];
  test: { status: string; story: string; problems: { text: string }[] } | null;
  problem: string | null;
  serv: number;
  dolphin: number;
  // Every test it was given, in order (a fix after a failed one included).
  tests?: { status: string; story: string; problems: { text: string }[] }[];
  logged?: string[];
}

const json = (url: string, method = "GET", body?: unknown) => new Request(`http://localhost${url}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const route = (id: string) => ({ params: Promise.resolve({ id }) });

// A chat turn's events, read to the end.
async function chatTurn(body: { conversationId?: string; content: string }): Promise<{ events: { type: string; data: Record<string, unknown> }[] }> {
  const chat = await import("@/app/api/chat/route");
  const res = await chat.POST(json("/api/chat", "POST", body));
  if (!res.body) return { events: [{ type: "error", data: { message: `status ${res.status}: ${await res.text()}` } }] };
  const text = await res.text();
  const events = text
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const type = /^event: (.+)$/m.exec(block)?.[1] ?? "";
      const data = /^data: (.+)$/m.exec(block)?.[1];
      return { type, data: data ? (JSON.parse(data) as Record<string, unknown>) : {} };
    });
  return { events };
}


// The steps in plain words, numbered, a loop's own steps set in.
export function planLines(d: NonNullable<AgentBuilderDTO["definition"]>): string[] {
  const depths = stepDepths(d);
  return stepsInOrder(d).map((s, i) => `${"  ".repeat(depths.get(s.id) ?? 0)}${i + 1}. ${stepLine(s, d)}`);
}

export async function runJourney(r: SuiteRequest, o: { db: PgliteDatabase<typeof schema>; user: schema.User; ledger: Ledger }): Promise<JourneyResult> {
  const out: JourneyResult = { id: r.id, name: r.name, stage: 1, passed: false, failure: null, turns: [], plan: [], test: null, problem: null, serv: 0, dolphin: 0 };
  const done = () => ({ ...out, serv: o.ledger.spent("serv", r.id), dolphin: o.ledger.spent("dolphin", r.id) });
  try {
    // 1 Describe.
    let conversationId: string | undefined;
    let sketch: SketchDTO | null = null;
    let offered = false;
    const says = [r.says, ...r.answers];
    for (let turn = 0; turn < says.length; turn++) {
      const { events } = await chatTurn({ conversationId, content: says[turn]! });
      const failed = events.find((e) => e.type === "error");
      conversationId ??= events.map((e) => e.data.conversationId as string | undefined).find(Boolean);
      offered ||= events.some((e) => e.type === "card");
      const s = events.filter((e) => e.type === "sketch").at(-1);
      if (s) sketch = s.data.sketch as SketchDTO;
      const reply = events.filter((e) => e.type === "delta").map((e) => String(e.data.text ?? "")).join("");
      out.turns.push({ said: says[turn]!, reply: reply || (failed ? `(error: ${String(failed.data.message)})` : ""), sketch: sketch && { name: sketch.name, kind: sketch.kind, wakes: sketch.wakes, looks: sketch.looks, handles: sketch.handles, finish: sketch.finish, asks: sketch.asks, asking: sketch.asking } });
      if (describedEnough(sketch)) break;
    }
    if (!conversationId) return { ...done(), failure: "The chat never answered." };
    if (!describedEnough(sketch)) return { ...done(), failure: sketch?.kind === "answer" ? "The chat took it for a one-off answer helper, not an agent." : `The chat still wanted more after ${out.turns.length} turns.` };

    // Make it is offered as a card under the reply once the job is clear.
    out.offered = out.turns.length > 0 && Boolean(offered);
    // 2 Steps: Make it.
    const agents = await import("@/app/api/agents/route");
    const made = await agents.POST(json("/api/agents", "POST", { conversationId, review: true }));
    if (made.status !== 202) return { ...done(), failure: `Make it was refused: ${await made.text()}` };
    const id = ((await made.json()) as { agent: { id: string } }).agent.id;
    const draftId = (await draftOf(id))!.id;
    await jobFor(draftId);
    const agentRoute = await import("@/app/api/agents/[id]/route");
    const load = async () => ((await (await agentRoute.GET(json(`/api/agents/${id}?view=builder`), route(id))).json()) as { builder: AgentBuilderDTO }).builder;
    let b = await load();
    if (b.definition) {
      out.stage = 2;
      out.plan = planLines(b.definition);
    }
    // 3 Build: Looks right, once the steps are there.
    if (b.definition && b.agent.buildState === "idle" && !b.agent.test) {
      const build = await import("@/app/api/agents/[id]/build/route");
      const res = await build.POST(json(`/api/agents/${id}/build`, "POST"), route(id));
      if (res.status !== 202) return { ...done(), failure: `Looks right was refused: ${await res.text()}` };
      await jobFor(draftId);
      b = await load();
    }
    if (b.definition) out.plan = planLines(b.definition);
    out.problem = b.agent.problem?.text ?? null;
    if (!b.definition) return { ...done(), failure: b.agent.buildNote ?? b.agent.problem?.text ?? "No steps came of it." };
    const held = b.agent.steps.filter((s) => s.code !== null && s.code !== "approved");
    if (held.length) return { ...done(), failure: b.agent.problem?.text ?? `${held.length} steps not built.` };
    out.stage = 3;
    const test = b.agent.test ? ((await draftOf(id))?.testResult ?? null) : null;
    if (!test) return { ...done(), failure: b.agent.problem?.text ?? "It was built but never tried." };
    out.stage = 4;
    out.test = { status: test.status, story: test.story, problems: test.problems };
    out.passed = test.status === "passed";
    if (!out.passed) out.failure = test.problems[0]?.text ?? test.story;
    return done();
  } catch (err) {
    return { ...done(), failure: `It stopped: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// The pass or fail table, one row per request.
export function table(results: JourneyResult[], ledger: Ledger): string {
  const rows = results.map((r) => `| ${r.name} | ${r.passed ? "passed" : "failed"} | ${["", "1 Describe", "2 Steps", "3 Build", "4 Try it"][r.stage]} | ${r.serv} | ${r.dolphin} | ${(r.failure ?? r.test?.story ?? "").replace(/\|/g, "/")} |`);
  return [
    "| Request | Result | Reached | SERV | Dolphin | What happened |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
    `Passed ${results.filter((r) => r.passed).length} of ${results.length}. SERV ${ledger.spent("serv")}, Dolphin ${ledger.spent("dolphin")}.`,
  ].join("\n");
}
