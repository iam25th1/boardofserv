// What a reply about an agent that has steps may not say: that it changed,
// tested or published the agent (only the card and the change path do
// that), or that a Plan button is there to press (a planned agent's card has
// none). A reply that says either is swapped for one that is true.

const CLAIMS = /\bI(?:'ve| have| just|'ll now)?\s+(?:just\s+)?(?:updated|changed|tweaked|adjusted|modified|fixed|rebuilt|re-?planned|tested|published|rewritten|rewrote|added|removed)\b/i;
const PLAN_BUTTON = /\b(?:hit|press|tap|click|use)\s+(?:the\s+)?["“]?plan\b|\bplan button\b/i;

export const HONEST_REPLY =
  "I can't change the agent from here on my own. Tell me what should work differently and I'll change the plan, or use Test it, Fix it, Publish and Details on its card.";

export function claimsTooMuch(text: string): boolean {
  return CLAIMS.test(text) || PLAN_BUTTON.test(text);
}

export function honestReply(text: string): string {
  return claimsTooMuch(text) ? HONEST_REPLY : text;
}
