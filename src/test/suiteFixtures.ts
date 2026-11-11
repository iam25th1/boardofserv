import { checkDefinition, codeSpec, type AgentDefinition, type CodeStepDef } from "@/lib/agents/definition";
import { wireToDefinition } from "@/lib/agents/plan";
import { emptyBench, type BenchData, type StepCode } from "@/lib/agents/types";

// Plans from the regression suite (suite/requests.ts) that handle one
// thing a run, as the planner's rules want them, in SERV's flat answer
// shape, with code written as SERV would approve it: the price watcher
// (one product page, a target, a question on Telegram, a reminder only on
// a yes), the morning line and the evening sales totals.

const step = <T extends Record<string, unknown>>(o: T) => ({ plain: "", inputs: [] as string[], outputs: [] as string[], next: "", description: "", tools: [] as string[], prompt: "", each: "", from: "", outcomes: [] as { id: string; label: string; next: string }[], action: "", otherwise: "", ...o });
const action = (id: string, tool: string, description: string) => ({ id, tool, description, askOver: "", askOverDay: "", amountColumn: "" });

export const PRICE_WIRE = {
  name: "Price watcher",
  job: { does: "Every day it reads the price on your product page, and when it is at or below your target it asks you on Telegram whether to send a reminder to buy it.", done: "The price was checked, and a reminder went out only if you said yes." },
  triggers: [{ kind: "schedule", every: "day", at: "09:00", everyMinutes: 0, watch: "", when: "", step: "", description: "Every day at 9:00" }],
  settings: [
    { key: "product_url", label: "The product page", type: "url", help: "The page whose price it reads.", choices: [] },
    { key: "target_price", label: "Your target price", type: "number", help: "It asks you when the price is at or below this.", choices: [] },
  ],
  rules: [],
  memory: [],
  actions: [action("ask_owner", "telegram.ask", "Ask you whether to send a reminder to buy it"), action("send_reminder", "telegram.send", "Send you the reminder to buy it")],
  steps: [
    step({ id: "read_price", title: "Read the price", kind: "code", inputs: ["settings"], outputs: ["price", "price_way"], next: "is_low", description: 'Fetch settings.product_url and find the price on the page: the first amount after a currency sign. Return price as a number, or null when there is none. Also return price_way: "low" when the price is at or below settings.target_price, else "not_low".', tools: ["web.fetch"] }),
    step({ id: "is_low", title: "At or below your target?", kind: "decision", inputs: ["price_way"], from: "price_way", prompt: "Is the price at or below the target?", outcomes: [{ id: "low", label: "At or below the target", next: "make_question" }, { id: "not_low", label: "Above the target", next: "" }] }),
    step({ id: "make_question", title: "Write the question", kind: "code", inputs: ["price", "settings"], outputs: ["question"], next: "ask", description: "Return question as telegram.ask's arguments: the price, the target and the page, asking whether to send a reminder to buy it, with the choices Yes and No." }),
    step({ id: "ask", title: "Ask you", kind: "action", action: "ask_owner", inputs: ["question"], outputs: ["reply"], next: "said_yes", otherwise: "" }),
    step({ id: "said_yes", title: "Did you say yes?", kind: "decision", inputs: ["reply"], from: "reply", prompt: "Did the owner say yes?", outcomes: [{ id: "yes", label: "Yes", next: "make_reminder" }, { id: "no", label: "No", next: "" }] }),
    step({ id: "make_reminder", title: "Write the reminder", kind: "code", inputs: ["price", "settings"], outputs: ["reminder"], next: "send", description: "Return reminder as telegram.send's arguments: a reminder to buy it, with the price and the page." }),
    step({ id: "send", title: "Send the reminder", kind: "action", action: "send_reminder", inputs: ["reminder"], next: "" }),
  ],
  limits: { maxSteps: 20, maxRunSeconds: 60, maxSpendUsd: 0.05 },
  approvalHours: 24,
};

export const PRICE_SOURCES: Record<string, string> = {
  read_price: `async function run(input, tools) {
  const page = await tools.web.fetch({ url: input.settings.product_url });
  const m = /[$£€]\\s*([0-9]+(?:[.,][0-9]{2})?)/.exec(page.text || "");
  const price = m ? Number(m[1].replace(",", ".")) : null;
  return { price, price_way: price !== null && price <= Number(input.settings.target_price) ? "low" : "not_low" };
}`,
  make_question: `async function run(input) {
  return { question: { question: "The price is now " + input.price + ", at or below your target of " + input.settings.target_price + ". Send you a reminder to buy it? " + input.settings.product_url, choices: ["Yes", "No"] } };
}`,
  make_reminder: `async function run(input) {
  return { reminder: { text: "Reminder: buy it now at " + input.price + ". " + input.settings.product_url } };
}`,
};

export function priceBench(): BenchData {
  return {
    ...emptyBench(),
    settings: { product_url: "https://shop.example/kettle", target_price: 50 },
    pages: { "https://shop.example/kettle": "Stone Kettle. Now $42.00. Free delivery." },
    telegram: { answers: ["Yes"] },
  };
}

export const MOTIVATION_WIRE = {
  name: "Morning motivation",
  job: { does: "Every morning at 8 it sends you a short motivational line on Telegram.", done: "The day's line was sent." },
  triggers: [{ kind: "schedule", every: "day", at: "08:00", everyMinutes: 0, watch: "", when: "", step: "", description: "Every morning at 8:00" }],
  settings: [],
  rules: [],
  memory: [],
  actions: [action("send_line", "telegram.send", "Send you the day's line")],
  steps: [
    step({ id: "pick_line", title: "Pick the day's line", kind: "code", inputs: ["trigger"], outputs: ["message"], next: "send", description: "Pick one of a list of short motivational lines by the day of the year, so each day has its own. Return message as telegram.send's arguments." }),
    step({ id: "send", title: "Send the line", kind: "action", action: "send_line", inputs: ["message"], next: "" }),
  ],
  limits: { maxSteps: 5, maxRunSeconds: 30, maxSpendUsd: 0.01 },
  approvalHours: 24,
};

export const MOTIVATION_SOURCES: Record<string, string> = {
  pick_line: `async function run(input) {
  const lines = ["Small steps every day add up.", "Start where you are. Use what you have.", "Done is better than perfect."];
  const day = Math.floor(Date.now() / 86400000);
  return { message: { text: lines[day % lines.length] } };
}`,
};

export const SALES_WIRE = {
  name: "Daily sales total",
  job: { does: "Every evening it adds up today's sales in your sheet and sends you the total and how many sales there were on Telegram.", done: "You have today's totals." },
  triggers: [{ kind: "schedule", every: "day", at: "20:00", everyMinutes: 0, watch: "", when: "", step: "", description: "Every evening at 20:00" }],
  settings: [{ key: "sales_sheet", label: "Your sales sheet", type: "sheet", help: "One row per sale, with Date and Amount columns.", choices: [] }],
  rules: [],
  memory: [],
  actions: [action("send_totals", "telegram.send", "Send you today's totals")],
  steps: [
    step({ id: "total", title: "Add up today's sales", kind: "code", inputs: ["settings", "trigger"], outputs: ["totals"], next: "send", description: "Read settings.sales_sheet. Take the rows whose Date is today, add up their Amount and count them. Return totals as telegram.send's arguments: today's total and how many sales.", tools: ["sheets.read"] }),
    step({ id: "send", title: "Send the totals", kind: "action", action: "send_totals", inputs: ["totals"], next: "" }),
  ],
  limits: { maxSteps: 5, maxRunSeconds: 30, maxSpendUsd: 0.01 },
  approvalHours: 24,
};

export const SALES_SOURCES: Record<string, string> = {
  total: `async function run(input, tools) {
  const { rows } = await tools.sheets.read({ sheet: input.settings.sales_sheet });
  const today = new Date().toISOString().slice(0, 10);
  const sold = rows.filter((r) => String(r.Date).slice(0, 10) === today);
  const sum = sold.reduce((t, r) => t + Number(r.Amount || 0), 0);
  return { totals: { text: "Today: " + sold.length + " sales, " + sum.toFixed(2) + " in total." } };
}`,
};

export function salesBench(): BenchData {
  const today = new Date().toISOString().slice(0, 10);
  return {
    ...emptyBench(),
    settings: { sales_sheet: "Sales" },
    sheets: { Sales: [{ Date: today, Amount: "12.50" }, { Date: today, Amount: "30" }, { Date: "2020-01-01", Amount: "99" }] },
  };
}

// A wire plan as a checked definition, or the reasons it isn't one.
export function definitionOf(wire: Record<string, unknown>): AgentDefinition {
  const checked = checkDefinition(wireToDefinition(wire));
  if (!checked.ok) throw new Error(checked.errors.join("; "));
  return checked.definition;
}

// Every code step's code, approved.
export function codeOf(d: AgentDefinition, sources: Record<string, string>): Record<string, StepCode> {
  return Object.fromEntries(
    d.steps
      .filter((s): s is CodeStepDef => s.kind === "code")
      .map((s) => [s.id, { spec: codeSpec(s), status: "approved" as const, source: sources[s.id] ?? null, rounds: 1, note: null, updatedAt: "2026-11-11T00:00:00.000Z" }]),
  );
}
