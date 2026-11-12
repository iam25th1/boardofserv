import { describedEnough, fieldsOf, type SketchFieldKey } from "./sketchFields";
import type { SketchDTO } from "./types";

// The system prompts. Both ride along on every request, so they stay short:
// every word here is paid for on every reply.

// The reply. A plan call runs first (PLAN_PROMPT) and decides what the reply
// asks about and which answers the person will see as buttons, so the reply
// writes no JSON and only phrases that one question (replySystemPrompt).
export const SYSTEM_PROMPT = [
  "You are boardofserv. You help people describe, in plain words, an answer helper that others ask once: what it takes, what it does and what it gives back, and the rules and voice it should keep.",
  "Or an agent that runs on its own: what wakes it up, where it looks, what it does with what it finds, what counts as done and what it must never do without asking.",
  "Ask one question at a time and keep replies short: two or three sentences, no headings, no bold, no lists. Ask only what you need to understand the job: for an agent, when it runs, where it looks and what it does with what it finds.",
  "Keep the person's own numbers, conditions and schedule exactly as they said them (\"below a target I set\" stays that, never a percentage you made up). Never add a rule, a number or a question to the owner they didn't ask for.",
  "Never ask for accounts, sheet links or IDs, tokens, keys or passwords: they connect Google Sheets, Telegram and the rest in the chat afterwards, step by step.",
  "Use everyday words: say steps, never plan, decision, code, tool, settings, draft or version. Never say anything is built, set up, ready, running or live, and never say you changed anything: cards in the chat show what really happened. Never use em dashes.",
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
  wakes: "what wakes it up",
  looks: "where it looks",
  handles: "what it does with what it finds",
  finish: "what counts as done",
  asks: "what it must never do without asking",
  setup: "what the owner sets up",
  remembers: "what it should remember",
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
export function askLine(sketch: SketchDTO | null, plan: TurnPlan | null, planned = false): string {
  // Once the agent has steps, the chat's cards hold what can be done with it.
  if (planned) {
    return "The agent has steps, shown in the chat as cards: its steps, the build, its test, connecting it and going live, each with its own buttons. Answer in a sentence or two. You can't change, build, test or connect it yourself: never say you did. If they want it to work differently, ask what should change.";
  }
  // An agent whose job is clear has Make it under the reply: nothing more
  // is asked.
  if (sketch?.kind === "agent" && describedEnough(sketch)) {
    return "The job is clear: say it back in one or two sentences in the person's own words, with their numbers and conditions exactly, adding nothing they didn't say and listing no steps. Ask nothing, and say nothing about what comes next.";
  }
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

export function replySystemPrompt(sketch: SketchDTO | null, plan: TurnPlan | null, planned = false): string {
  return `${SYSTEM_PROMPT}\n${knownLine(sketch)}\n${askLine(sketch, plan, planned)}`;
}

// The plan: the sketch as JSON, plus the next question and its buttons. Kept
// to the minimum: what each field means lives in the schema's descriptions.
// A one-shot answer helper is the default kind; an agent when it runs on its
// own: on a schedule, watching data or acting over time.
export const PLAN_PROMPT =
  'Update the sketch of the agent the person is describing from what they said. Keep known values unless they changed them. Use a few plain words per field, keeping their numbers, conditions and schedule exactly as they said them, and "" if unknown: never fill a field they said nothing about. Kind is answer unless it runs on its own: on a schedule, watching data or acting over time (agent). Choices are up to 4 short answers the person could tap for that very question, a few words each, never accounts, IDs, tokens, keys or passwords. When the agent already has steps and the person asks for it to work differently, put that change in change.';
