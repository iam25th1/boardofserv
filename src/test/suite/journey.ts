import type { PgliteDatabase } from "drizzle-orm/pglite";
import { asc, eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { jobFor } from "@/lib/agents/build";
import { stepDepths, stepLine, stepsInOrder } from "@/lib/agents/plainView";
import { draftOf, versionsOf } from "@/lib/agents/store";
import { setupShapeOf } from "@/lib/agents/definition";
import { describedEnough } from "@/lib/sketchFields";
import type { AgentDefinition } from "@/lib/agents/definition";
import type { AgentSummaryDTO, SketchDTO } from "@/lib/types";
import type { HealLog } from "@/lib/agents/types";
import type { Ledger } from "./live";
import { answerTo, pickChoice, setupAnswer, type SuiteRequest } from "./requests";

// One request taken through the journey a maker takes in the chat, through
// the real routes, the way a maker would: the first message, then only
// answers to what the chat asks (picked from what they know, suite/
// requests.ts); Make it; Looks right; any question the fixer asks, answered
// by tapping one of its answers; Connect, with what it asks for; and Run it
// for me. Nothing is ever typed to fix it. Where it got to, in the six
// stages the chat shows: 1 Describe, 2 Steps, 3 Build, 4 Try it (its test
// passed), 5 Connect, 6 Go live (running for the maker).

export interface JourneyResult {
  id: string;
  name: string;
  stage: 1 | 2 | 3 | 4 | 5 | 6;
  // It went live with a passing test and nothing typed to fix it.
  passed: boolean;
  // Why it stopped, in one line, when it didn't.
  failure: string | null;
  turns: { said: string; reply: string }[];
  // Every question it asked the maker: the chat's, and the fixer's with
  // what was tapped.
  questions: { from: "chat" | "fixer"; question: string; answer: string }[];
  plan: string[];
  test: { status: string; story: string; problems: { text: string }[] } | null;
  // Each repair round: where it failed, what the fixer made of it, what it
  // did and how that went.
  repairs: { stage: string; step: string | null; failure: string; verdict: string | null; why: string; repair: string; outcome: string; rejected?: string | null }[];
  rounds: number;
  // Things the maker typed to fix it: always none.
  typedFixes: number;
  serv: number;
  dolphin: number;
  logged?: string[];
}

const json = (url: string, method = "GET", body?: unknown) => new Request(`http://localhost${url}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const route = (id: string) => ({ params: Promise.resolve({ id }) });

// A chat turn's events, read to the end.
async function chatTurn(body: { conversationId?: string; content: string }): Promise<{ type: string; data: Record<string, unknown> }[]> {
  const chat = await import("@/app/api/chat/route");
  const res = await chat.POST(json("/api/chat", "POST", body));
  if (!res.body) return [{ type: "error", data: { message: `status ${res.status}: ${await res.text()}` } }];
  return (await res.text())
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const type = /^event: (.+)$/m.exec(block)?.[1] ?? "";
      const data = /^data: (.+)$/m.exec(block)?.[1];
      return { type, data: data ? (JSON.parse(data) as Record<string, unknown>) : {} };
    });
}

// The steps in plain words, numbered, a loop's own steps set in.
export function planLines(d: AgentDefinition): string[] {
  const depths = stepDepths(d);
  return stepsInOrder(d).map((s, i) => `${"  ".repeat(depths.get(s.id) ?? 0)}${i + 1}. ${stepLine(s, d)}`);
}

// A sheet the maker picks at Connect: a link to their spreadsheet, and a tab.
const SHEET = "https://docs.google.com/spreadsheets/d/1SuiteSheetSuiteSheetSuiteSheet00/edit";

export async function runJourney(r: SuiteRequest, o: { db: PgliteDatabase<typeof schema>; user: schema.User; ledger: Ledger; onPlan?: (d: AgentDefinition) => void }): Promise<JourneyResult> {
  const out: JourneyResult = { id: r.id, name: r.name, stage: 1, passed: false, failure: null, turns: [], questions: [], plan: [], test: null, repairs: [], rounds: 0, typedFixes: 0, serv: 0, dolphin: 0 };
  let agentId: string | null = null;
  const done = async () => {
    const draft = agentId ? ((await draftOf(agentId)) ?? (await versionsOf(agentId))[0] ?? null) : null;
    const heal = (draft?.heal ?? null) as HealLog | null;
    out.repairs = (heal?.rounds ?? []).map((x) => ({ stage: x.diagnosis.stage, step: x.diagnosis.step?.title ?? null, failure: x.diagnosis.failure, verdict: x.verdict, why: x.why, repair: x.repair, outcome: x.outcome, ...(x.rejected ? { rejected: x.rejected } : {}) }));
    out.rounds = out.repairs.filter((x) => x.verdict !== null).length;
    return { ...out, serv: o.ledger.spent("serv", r.id), dolphin: o.ledger.spent("dolphin", r.id) };
  };
  try {
    // 1 Describe: the first message, then answers to what it asks.
    let conversationId: string | undefined;
    let sketch: SketchDTO | null = null;
    let said = r.says;
    for (let turn = 0; turn < 6; turn++) {
      const events = await chatTurn({ conversationId, content: said });
      const failed = events.find((e) => e.type === "error");
      conversationId ??= events.map((e) => e.data.conversationId as string | undefined).find(Boolean);
      const s = events.filter((e) => e.type === "sketch").at(-1);
      if (s) sketch = s.data.sketch as SketchDTO;
      const reply = events.filter((e) => e.type === "delta").map((e) => String(e.data.text ?? "")).join("");
      out.turns.push({ said, reply: reply || (failed ? `(error: ${String(failed.data.message)})` : "") });
      if (describedEnough(sketch)) break;
      // A question, answered with what the maker knows.
      said = answerTo(r, reply);
      out.questions.push({ from: "chat", question: reply, answer: said });
    }
    if (!conversationId) return { ...(await done()), failure: "The chat never answered." };
    if (!describedEnough(sketch)) return { ...(await done()), failure: sketch?.kind === "answer" ? "The chat took it for a one-off answer helper, not an agent." : `The chat still wanted more after ${out.turns.length} turns.` };

    const agents = await import("@/app/api/agents/route");
    const agentRoute = await import("@/app/api/agents/[id]/route");
    const load = async (): Promise<AgentSummaryDTO> => ((await (await agentRoute.GET(json(`/api/agents/${agentId}`), route(agentId!))).json()) as { agent: AgentSummaryDTO }).agent;
    const settled = async () => {
      const d = await draftOf(agentId!);
      if (d) await jobFor(d.id);
    };
    // The fixer's questions, answered by tapping one of its answers, until
    // it stops asking (a few at most).
    const answerQuestions = async (): Promise<AgentSummaryDTO> => {
      let a = await load();
      for (let i = 0; i < 3 && a.heal?.question; i++) {
        const q = a.heal.question;
        const answer = pickChoice(r, q.text, q.choices);
        out.questions.push({ from: "fixer", question: q.text, answer });
        await chatTurn({ conversationId, content: answer });
        await settled();
        a = await load();
      }
      return a;
    };

    // 2 Steps: Make it.
    const made = await agents.POST(json("/api/agents", "POST", { conversationId, review: true }));
    if (made.status !== 202) return { ...(await done()), failure: `Make it was refused: ${await made.text()}` };
    agentId = ((await made.json()) as { agent: { id: string } }).agent.id;
    await settled();
    let a = await answerQuestions();
    const definition = async () => (await draftOf(agentId!))?.definition ?? null;
    let d = await definition();
    if (!d) return { ...(await done()), failure: a.heal?.gaveUp ?? a.buildNote ?? a.problem?.text ?? "No steps came of it." };
    out.stage = 2;
    out.plan = planLines(d);
    o.onPlan?.(d);

    // 3 Build and 4 Try it: Looks right; it heals itself as it goes.
    const build = await import("@/app/api/agents/[id]/build/route");
    const res = await build.POST(json(`/api/agents/${agentId}/build`, "POST"), route(agentId));
    if (res.status !== 202) return { ...(await done()), failure: `Looks right was refused: ${await res.text()}` };
    await settled();
    a = await answerQuestions();
    d = (await definition()) ?? d;
    out.plan = planLines(d);
    const draft = (await draftOf(agentId))!;
    if (d.steps.every((s) => s.kind !== "code" || draft.code[s.id]?.status === "approved")) out.stage = 3;
    const test = draft.testResult;
    if (test) out.test = { status: test.status, story: test.story, problems: test.problems };
    if (test?.status !== "passed") return { ...(await done()), failure: a.heal?.gaveUp ?? test?.problems[0]?.text ?? a.problem?.text ?? "It was built but never passed its test." };
    out.stage = 4;

    // 5 Connect: what it asks for, as the maker answers it.
    const setup = setupShapeOf(d);
    const given = Object.fromEntries(d.settings.flatMap((s) => (s.given ? [[s.key, s.given]] : [])));
    const settings: Record<string, unknown> = {};
    const tabs = r.tabs ?? [];
    for (const [i, s] of setup.settings.entries()) {
      if (s.type === "sheet") {
        const tab = tabs.find((t) => new RegExp(t, "i").test(`${s.key} ${s.label}`)) ?? tabs[i % Math.max(1, tabs.length)] ?? "Sheet1";
        settings[s.key] = { url: SHEET, tab };
      } else settings[s.key] = s.type === "boolean" ? false : (given[s.key] ?? setupAnswer(r, s) ?? (s.type === "choice" ? s.choices[0] : s.type === "number" ? "1" : s.type === "url" ? "https://example.com/page" : s.type === "list" ? "One, Two" : "Yes"));
    }
    const answers = { settings, rules: Object.fromEntries(setup.rules.map((x) => [x.key, x.value])), timezone: "Europe/London", schedule: null, payee: setup.spends ? (r.payee ?? { label: String(settings[setup.payee ?? ""] ?? "Payee"), address: "" }) : null };
    const journey = await import("@/app/api/conversations/[id]/journey/route");
    const connected = await journey.POST(json(`/api/conversations/${conversationId}/journey`, "POST", { action: "connect", answers }), route(conversationId));
    if (connected.status !== 200) return { ...(await done()), failure: `Connect said: ${await connected.text()}` };
    out.stage = 5;

    // 6 Go live: Run it for me.
    const golive = await import("@/app/api/agents/[id]/golive/route");
    const ran = await golive.POST(json(`/api/agents/${agentId}/golive`, "POST", { how: "run" }), route(agentId));
    if (ran.status === 202) await settled();
    else if (ran.status !== 200) return { ...(await done()), failure: `Run it for me said: ${await ran.text()}` };
    const live = (await o.db.select().from(schema.messages).where(eq(schema.messages.conversationId, conversationId)).orderBy(asc(schema.messages.createdAt))).filter((m) => m.card?.stage === "live").at(-1);
    if (!live?.card?.live?.installationId) return { ...(await done()), failure: (await load()).heal?.gaveUp ?? "It didn't go live." };
    out.stage = 6;
    out.passed = out.typedFixes === 0;
    return await done();
  } catch (err) {
    return { ...(await done()), failure: `It stopped: ${err instanceof Error ? err.message : String(err)}` };
  }
}

const STAGES = ["", "1 Describe", "2 Steps", "3 Build", "4 Try it", "5 Connect", "6 Go live"];

// The pass or fail table, one row per request.
export function table(results: JourneyResult[], ledger: Ledger): string {
  const rows = results.map((r) => {
    const repairs = r.repairs.filter((x) => x.verdict).map((x) => `${x.verdict} (${x.outcome})`).join(", ") || "none";
    const asked = r.questions.map((q) => `${q.from}: ${q.question.replace(/\s+/g, " ").slice(0, 80)}`).join(" / ") || "none";
    return `| ${r.name} | ${r.passed ? "passed" : "failed"} | ${STAGES[r.stage]} | ${r.rounds} | ${repairs} | ${asked.replace(/\|/g, "/")} | ${r.serv} | ${r.dolphin} | ${(r.failure ?? r.test?.story ?? "").replace(/\|/g, "/")} |`;
  });
  return [
    "| Request | Result | Reached | Rounds | Repairs | Questions | SERV | Dolphin | What happened |",
    "|---|---|---|---|---|---|---|---|---|",
    ...rows,
    "",
    `Went live ${results.filter((r) => r.passed).length} of ${results.length}. SERV ${ledger.spent("serv")}, Dolphin ${ledger.spent("dolphin")}.`,
  ].join("\n");
}
