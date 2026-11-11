// What a reply about an agent may not say: that anything is built, tested,
// set up, ready, live or running, or that it changed anything (only the
// chat's cards say what really happened, and the steps change only through
// them), or that a Plan button is there to press (there is none). A
// sentence that says so is left out; a reply with nothing left says what is
// true instead.

const CLAIMS = /\bI(?:'ve| have| just|'ll now| will now)?\s+(?:just\s+)?(?:updated|changed|tweaked|adjusted|modified|fixed|rebuilt|re-?planned|tested|published|rewritten|rewrote|added|removed|built|created|made|set (?:it )?up|configured|connected|deployed|started|launched|scheduled)\b/i;
const DONE = /\b(?:is|are|it's|it is|they're|all)\s+(?:now\s+)?(?:all\s+)?(?:set(?:\s+up)?|ready to go|ready|built|live|running|up and running|configured|connected|deployed|done|scheduled|active|working)\b/i;
const PLAN_BUTTON = /\b(?:hit|press|tap|click|use)\s+(?:the\s+)?["“]?plan\b|\bplan button\b/i;

export const HONEST_REPLY = "The cards below show where it is and what you can do next.";

export function claimsTooMuch(text: string): boolean {
  return CLAIMS.test(text) || DONE.test(text) || PLAN_BUTTON.test(text);
}

// The reply with every sentence that claims too much left out, or the
// fallback when nothing is left.
export function honestReply(text: string, fallback = HONEST_REPLY): string {
  if (!claimsTooMuch(text)) return text;
  const kept = text
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !claimsTooMuch(sentence))
    .join(" ")
    .trim();
  return kept && /[a-z]/i.test(kept) ? kept : fallback;
}
