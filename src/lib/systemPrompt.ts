import type { SketchDTO } from "./types";

// The system prompts. Both ride along on every request, so they stay short:
// every word here is paid for on every reply.

// The reply. A plan call runs first (PLAN_PROMPT) and decides what the reply
// asks about and which answers the person will see as buttons, so the reply
// writes no JSON and only phrases that one question (replySystemPrompt).
export const SYSTEM_PROMPT = [
  "You are boardofserv. You help people describe, in plain words, an agent they want: what it watches, when it acts, how often it checks and where it tells them.",
  "Ask one question at a time and keep replies short.",
  "Use everyday language and do not mention APIs, keys or code unless asked. Do not claim to build or run anything. Never use em dashes.",
].join(" ");

const FIELDS = ["watches", "when", "how", "tells"] as const;

// What each field means, for the reply's "Ask about" line.
const ABOUT: Record<(typeof FIELDS)[number], string> = {
  watches: "what it watches",
  when: "when it acts",
  how: "how often it checks",
  tells: "where it tells them",
};

// What the sketch holds, as one short plain line.
export function knownLine(sketch: SketchDTO | null): string {
  const known = (["name", "kind", ...FIELDS] as const).flatMap((k) => (sketch?.[k] ? [`${k} ${sketch[k]}`] : []));
  const missing = FIELDS.filter((k) => !sketch?.[k]);
  return `Known so far: ${known.length ? known.join(", ") : "nothing yet"}; missing: ${missing.length ? missing.join(", ") : "nothing"}.`;
}

// What the plan decided for this turn: the field the reply asks about and the
// answers shown under it as buttons.
export interface TurnPlan {
  asking: SketchDTO["asking"];
  choices: string[];
}

// What the reply does this turn. With a plan, it asks exactly what the plan
// chose, in words that fit the buttons. With nothing left to ask, it confirms.
// Without a plan (it failed or did not validate), it picks the question itself
// and there are no buttons.
export function askLine(sketch: SketchDTO | null, plan: TurnPlan | null): string {
  if (plan?.asking) {
    const ask = `Ask about: ${plan.asking} (${ABOUT[plan.asking]}).`;
    if (!plan.choices.length) return ask;
    return `${ask} The user will see these buttons: ${plan.choices.map((c) => `"${c}"`).join(", ")}. Your question must fit them.`;
  }
  if (FIELDS.every((k) => sketch?.[k])) {
    return "The agent is fully described: confirm that, say switching it on comes in the next update, and ask nothing.";
  }
  return "Ask about the most important missing piece.";
}

export function replySystemPrompt(sketch: SketchDTO | null, plan: TurnPlan | null): string {
  return `${SYSTEM_PROMPT}\n${knownLine(sketch)}\n${askLine(sketch, plan)}`;
}

// The plan: the sketch as JSON, plus the next question and its buttons. Kept
// to the minimum: what each field means lives in the schema's descriptions.
export const PLAN_PROMPT = 'Update the sketch of the agent the person is describing from what they said. Keep known values unless they changed them. Use a few plain words per field and "" if unknown.';
