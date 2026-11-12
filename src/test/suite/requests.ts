// The regression suite: eight real requests, in the maker's own words. The
// live suite (suite-live.test.ts) takes each one through the whole journey
// in the chat, as a maker would: the first message, then only answers to
// what the chat asks, picked here from what the maker knows; then Make it,
// Looks right, Connect with the answers it asks for, and Run it for me. The
// recorded run (suite.test.ts) checks the same journeys offline.

// The owner's own linked wallet: the payee the paying agents pay.
export const OWNER_WALLET = "0x0000000000000000000000000000000000000000";

export interface SuiteRequest {
  id: string;
  name: string;
  // The first message, as a maker typed it.
  says: string;
  // What the maker answers when the chat asks: the first question pattern
  // that matches picks the answer; otherwise is what they say to anything
  // else.
  knows: [RegExp, string][];
  otherwise: string;
  // Their answers at Connect, by what a setting asks (its words or key),
  // beyond what they gave while describing it.
  setup: [RegExp, string][];
  // The tabs of their Google sheet, when it works on one.
  tabs?: string[];
  // Who it pays, when it pays someone.
  payee?: { label: string; address: string };
}

const NEVER_ASKS: [RegExp, string] = [/\bask\b|approv|permission|confirm|before/i, "It never needs to ask me anything first."];

export const SUITE: SuiteRequest[] = [
  {
    id: "motivation",
    name: "Morning motivation",
    says: "Every morning at 8, send me a Telegram message with a short motivational line for the day.",
    knows: [[/where|look|read|source|which|from/i, "It doesn't read anything: it picks a short line itself each morning."], NEVER_ASKS, [/when|time|often|day/i, "Every morning at 8."]],
    otherwise: "Just the one message each morning, nothing else.",
    setup: [],
  },
  {
    id: "sales",
    name: "Daily sales total",
    says: "Every evening, read my Google Sheet of daily sales, one row per sale with an Amount column, add up today's total and how many sales there were, and send me the totals on Telegram.",
    knows: [[/column|date|row|today|sheet/i, "Each row has a Date column and an Amount column."], NEVER_ASKS, [/when|time|evening/i, "Every evening at 8."]],
    otherwise: "It only reads the sheet and sends me the totals.",
    setup: [],
    tabs: ["Sales"],
  },
  {
    id: "enquiries",
    name: "Enquiry priority",
    says: "Every hour, check my Google Sheet of customer enquiries for new rows. For each new row, decide whether it's urgent or not urgent, and write the answer in a Priority column of that row. Leave rows I've already checked alone.",
    knows: [[/urgent|decide|how/i, "Urgent means the customer needs an answer today; anything else is not urgent."], [/column|row|new|checked|sheet/i, "Each row has a Message column with what the customer wrote. A row is checked once its Priority is filled in."], NEVER_ASKS],
    otherwise: "That's all it does.",
    setup: [],
    tabs: ["Enquiries"],
  },
  {
    id: "price",
    name: "Price watcher",
    says: "Every day, check a product page I give you and read its price. If the price is below a target I set, ask me on Telegram whether I want a reminder to buy it, and only send the reminder if I say yes.",
    knows: [[/target|how much|price/i, "I'll give you my target price when I set it up."], [/page|link|product|which|where/i, "It's one product page. I'll give you the link when I set it up."], [/yes|no\b|send|remind/i, "Only send the reminder if I say yes."]],
    otherwise: "That's everything.",
    setup: [[/url|page|link|product/i, "https://shop.example/kettle"], [/target|price/i, "50"]],
  },
  {
    id: "supplies",
    name: "Supplies restock",
    says: "Every Monday, check my Google Sheet of supplies. If any item's quantity is below its minimum, work out the cost to restock it at the price in the sheet, and ask me on Telegram before paying the supplier saved as a payee.",
    knows: [[/supplier|payee|who|pay\b|name/i, "The supplier is saved as my payee called Weftworks."], [/column|sheet|row/i, "The sheet has Item, Quantity, Minimum and Price columns."], [/restock|how much|cost|buy/i, "Restocking means buying enough to get back up to the minimum."], [/ask|yes|approv/i, "It must never pay without my yes."]],
    otherwise: "That's everything.",
    setup: [[/supplier|payee|pay/i, "Weftworks"]],
    tabs: ["Supplies"],
    payee: { label: "Weftworks", address: OWNER_WALLET },
  },
  {
    id: "hackathon",
    name: "Hackathon Submission Checker",
    says: "Make me a Hackathon Submission Checker. Submissions arrive as rows in a Google Sheet. Every 15 minutes, check the new rows. For each submission, judge each requirement in my list as met or not met, one requirement at a time. Count the met ones: fewer than half met means rejected, otherwise passed. Write Status and Reasons into that submission's own row, with Reasons naming each requirement as met or not met. Then send me one Telegram summary covering every submission checked. The next run should leave checked rows alone.",
    knows: [[/requirement|list|criteria/i, "I'll give you the list of requirements when I set it up."], [/column|checked|status|row|new/i, "A row is checked once its Status is filled in."], NEVER_ASKS],
    otherwise: "That's everything.",
    setup: [[/requirement|criteria|list/i, "Has a public demo link, Uses SERV, Has a README"]],
    tabs: ["Submissions"],
  },
  {
    id: "eth",
    name: "ETH price alert",
    says: "Every 15 minutes, get the ETH price in USD from https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd. If it's below my target price, message me on Telegram with the current price. Don't message me again until it goes back above the target and drops below it again.",
    knows: [[/target|how much|price/i, "I'll give you my target price when I set it up."], [/again|repeat|remind|once/i, "Only once each time it drops below the target: not again until it has gone back above it."], NEVER_ASKS],
    otherwise: "That's everything.",
    setup: [[/target|price|threshold/i, "3000"], [/url|link|api|source/i, "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd"]],
  },
  {
    id: "designer",
    name: "Designer payment",
    says: "Every Friday, pay 0.5 USDC from this agent's allowance to my saved payee called Designer, and ask me on Telegram before paying.",
    knows: [[/payee|designer|who|name/i, "Designer is already saved as my payee."], [/amount|how much/i, "0.5 USDC each time."], [/when|time|friday/i, "Every Friday morning at 9."]],
    otherwise: "That's everything.",
    setup: [[/payee|who|pay to|recipient/i, "Designer"], [/amount|how much|usdc/i, "0.5"]],
    payee: { label: "Designer", address: OWNER_WALLET },
  },
];

// The maker's answer to a question: what they know about it, or what they
// say to anything else.
export function answerTo(r: SuiteRequest, question: string): string {
  return r.knows.find(([q]) => q.test(question))?.[1] ?? r.otherwise;
}

// The answer they tap, from the ones offered: the one closest to what they
// know about the question, else the first.
export function pickChoice(r: SuiteRequest, question: string, choices: string[]): string {
  const known = answerTo(r, question).toLowerCase();
  const words = (t: string) => t.toLowerCase().split(/[^a-z0-9.]+/).filter((w) => w.length > 2);
  const score = (c: string) => words(c).filter((w) => known.includes(w)).length;
  return [...choices].sort((a, b) => score(b) - score(a))[0] ?? choices[0]!;
}

// Their answer at Connect to one setting.
export function setupAnswer(r: SuiteRequest, s: { key: string; label: string }): string | null {
  const said = `${s.key.replace(/_/g, " ")} ${s.label}`;
  return r.setup.find(([q]) => q.test(said))?.[1] ?? null;
}
