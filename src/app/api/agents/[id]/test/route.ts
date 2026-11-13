import { notLetIn } from "@/lib/access";
import { recordAgentCall, summaryOf } from "@/lib/agents/build";
import { buildContext } from "@/lib/agents/context";
import { ownedAgent } from "@/lib/agents/owned";
import { currentVersion, setTestResult, updateDraft } from "@/lib/agents/store";
import { testVersion } from "@/lib/agents/test";
import { refusal } from "@/lib/spend";
import { addCard, cardsIn } from "@/lib/agents/journey";
import { errorText } from "@/lib/db/errors";

export const runtime = "nodejs";

// "Test it": the agent runs once on sample data made from its own plan
// (agents/test.ts), and the answer is the run as a short story. SERV makes
// the sample the first time (and again when the plan changes) and makes
// the run's decisions, on the maker's key when they have one; within the
// day's limits, or with no SERV at all, it runs dry on a plain sample. A
// draft keeps the sample as its test bench's data.
export async function POST(req: Request, route: { params: Promise<{ id: string }> }) {
  const params = await route.params;
  const who = await ownedAgent(req, params.id);
  if ("refused" in who) return who.refused;
  const shut = notLetIn(who.user);
  if (shut) return shut;
  const version = await currentVersion(who.agent.id);
  if (!version?.definition) return Response.json({ error: "There are no steps yet." }, { status: 400 });
  if (version.state === "draft" && version.buildState !== "idle") return Response.json({ error: "Wait for it to finish building." }, { status: 409 });
  const waiting = version.definition.steps.find((s) => s.kind === "code" && version.code[s.id]?.status !== "approved");
  if (waiting) return Response.json({ error: `"${waiting.title}" isn't ready yet, so it can't run.` }, { status: 409 });

  const ctx = buildContext(who.user, who.agent.sourceConversationId);
  const no = ctx ? await refusal(who.user.id, { ownKey: ctx.ownKey }) : null;
  const live = Boolean(ctx) && !no;
  try {
    const tested = await testVersion(
      { definition: version.definition, code: version.code, testResult: version.testResult },
      {
        serv: live ? ctx!.serv : null,
        live,
        kind: "manual",
        record: (call, kind) => recordAgentCall(ctx!, kind === "sample" ? "agent_plan" : "agent_decision", call),
        signal: req.signal,
        timeZone: who.user.timezone,
      },
    );
    await setTestResult(version.id, tested.result);
    if (version.state === "draft") await updateDraft(version.id, { bench: tested.bench });
    // Tried again from the chat's Try it card: a pass goes on to Connect.
    const journey = Boolean(((await req.json().catch(() => null)) as { journey?: unknown } | null)?.journey);
    const conversationId = who.agent.sourceConversationId;
    if (journey && conversationId && tested.result.status === "passed" && (await cardsIn(conversationId)).at(-1)?.card?.stage === "try") {
      await addCard(conversationId, { stage: "connect", agentId: who.agent.id }, "Connecting it to what it needs.");
    }
    return Response.json({ test: tested.result, agent: summaryOf(who.agent, { ...version, testResult: tested.result }) });
  } catch (err) {
    console.error(`agents: a test stopped: ${errorText(err, "unknown error")}`);
    return Response.json({ error: "The test stopped part way. Try again." }, { status: 500 });
  }
}
