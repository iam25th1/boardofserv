import { fieldsOf, type SketchFieldKey } from "./sketchFields";
import type { SketchDTO } from "./types";

// The system prompts. Both ride along on every request, so they stay short:
// every word here is paid for on every reply.

// The reply. A plan call runs first (PLAN_PROMPT) and decides what the reply
// asks about and which answers the person will see as buttons, so the reply
// writes no JSON and only phrases that one question (replySystemPrompt).
export const SYSTEM_PROMPT = [
  "You are boardofserv. You help people describe, in plain words, an agent they want: what it watches, when it acts, how often it checks and where it tells them.",
  "Or an answer helper that others ask once: what it takes, what it does and what it gives back, and the rules and voice it should keep.",
  "Ask one question at a time and keep replies short.",
  "Use everyday language and do not mention APIs, keys or code unless asked. Do not claim to build or run anything. Never use em dashes.",
].join(" ");

// What each field means, for the reply's "Ask about" line.
const ABOUT: Record<SketchFieldKey, string> = {
  watches: "what it watches",
  when: "when it acts",
  how: "how often it checks",
  tells: "where it tells them",
  takes: "what the user gives it",
  does: "what it does",
  gives: "what comes back",
};

// What the sketch holds, as one short plain line: the fields of its kind.
export function knownLine(sketch: SketchDTO | null): string {
  const fields = fieldsOf(sketch?.kind ?? null);
  const known = (["name", "kind", ...fields] as const).flatMap((k) => (sketch?.[k] ? [`${k} ${sketch[k]}`] : []));
  const missing = fields.filter((k) => !sketch?.[k]);
  return `Known so far: ${known.length ? known.join(", ") : "nothing yet"}; missing: ${missing.length ? missing.join(", ") : "nothing"}.`;
}

// What the plan decided for this turn: the field the reply asks about and the
// answers shown under it as buttons.
export interface TurnPlan {
  asking: SketchDTO["asking"];
  choices: string[];
}

// What the reply does this turn. With a plan, it asks exactly what the plan
// chose, in words that fit the buttons. With nothing left to ask, an agent is
// confirmed; an answer helper is asked for its rules and voice, then confirmed
// as ready to publish. Without a plan (it failed or did not validate), the
// reply picks the question itself and there are no buttons.
export function askLine(sketch: SketchDTO | null, plan: TurnPlan | null): string {
  if (plan?.asking) {
    const ask = `Ask about: ${plan.asking} (${ABOUT[plan.asking]}).`;
    if (!plan.choices.length) return ask;
    return `${ask} The user will see these buttons: ${plan.choices.map((c) => `"${c}"`).join(", ")}. Your question must fit them.`;
  }
  if (fieldsOf(sketch?.kind ?? null).every((k) => sketch?.[k])) {
    if (sketch?.kind === "answer") {
      return "The helper is fully described. If the conversation has no rules or voice for it yet, ask what it must always or never do and how it should sound; otherwise confirm it and say the Publish button on the sketch puts it on the board.";
    }
    return "The agent is fully described: confirm that, say switching it on comes in the next update, and ask nothing.";
  }
  return "Ask about the most important missing piece.";
}

export function replySystemPrompt(sketch: SketchDTO | null, plan: TurnPlan | null): string {
  return `${SYSTEM_PROMPT}\n${knownLine(sketch)}\n${askLine(sketch, plan)}`;
}

// The plan: the sketch as JSON, plus the next question and its buttons. Kept
// to the minimum: what each field means lives in the schema's descriptions.
// A one-shot answer helper is the default kind; a watcher or a digest only
// when the person mentions something to monitor or a schedule.
export const PLAN_PROMPT =
  'Update the sketch of the agent the person is describing from what they said. Keep known values unless they changed them. Use a few plain words per field and "" if unknown. Kind is answer unless they mention a schedule (digest) or something to keep watching (watcher).';
