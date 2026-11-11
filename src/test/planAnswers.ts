// SERV planning an agent, for tests: a whole plan in the wire shape (as
// agentFixtures.ts has them) answered the way the two stages ask for it
// (agents/planStages.ts). An outline request gets the plan's setup and its
// steps' names, kinds and places; a details request gets the steps it
// names, in full.

type Wire = Record<string, unknown>;
type Step = Record<string, unknown>;

export function outlineOf(wire: Wire): Wire {
  const steps = (wire.steps as Step[]).map((s) => ({ id: s.id, title: s.title, kind: s.kind, purpose: s.title, next: s.kind === "decision" ? "" : (s.next ?? ""), body: s.body ?? "" }));
  return { ...wire, steps };
}

// The steps a details request asks for, from its "Detail these steps:" list.
export function askedSteps(request: string): string[] {
  const tail = request.slice(request.lastIndexOf("Detail these steps:"));
  return [...tail.matchAll(/^- ([a-z][a-z0-9_]*):/gm)].map((m) => m[1]!);
}

export function detailsOf(wire: Wire, ids: string[]): Wire {
  const steps = (wire.steps as Step[])
    .filter((s) => ids.includes(String(s.id)))
    .map((s) => ({
      id: s.id,
      inputs: s.inputs ?? [],
      outputs: s.outputs ?? [],
      description: s.description ?? "",
      tools: s.tools ?? [],
      prompt: s.prompt ?? "",
      from: s.from ?? "",
      outcomes: s.outcomes ?? [],
      action: s.action ?? "",
      otherwise: s.otherwise ?? "",
      over: s.over ?? "",
      item: s.item ?? "",
      gather: s.gather ?? [],
    }));
  return { steps };
}

interface PlanBody {
  messages?: { role: string; content: string }[];
  response_format?: { json_schema?: { name?: string } };
}

// SERV's answer to one planning call, or null when the call isn't one.
export function planAnswer(wire: Wire, body: PlanBody): Wire | null {
  const name = body.response_format?.json_schema?.name;
  if (name === "agent_outline") return outlineOf(wire);
  if (name === "agent_steps") return detailsOf(wire, askedSteps(body.messages?.at(-1)?.content ?? ""));
  return null;
}

export const isPlanCall = (name: string | undefined) => name === "agent_outline" || name === "agent_steps";
