import type { AgentDefinition } from "../definition";
import { emptyBench } from "../types";
import type { Recipe, RecipeFill } from "./types";

// A scheduled payment with the owner's approval: a set amount of USDC to a
// saved payee, on a schedule, and a receipt. The offline suite's Designer
// payment, which goes live every time. The payment itself asks the owner
// first (every payment asks unless they raise their own auto limit), so
// the plan has no question of its own.

const prepareCode = [
  "async function run(input) {",
  "  const s = input.settings || {};",
  '  const to = String(s.payee || "").trim();',
  "  const amount = Number(s.amount);",
  "  if (!to || !(amount > 0)) return { payment: null };",
  '  return { payment: { to: to, amountUsdc: amount, memo: "Scheduled payment" } };',
  "}",
].join("\n");

const receiptCode = [
  "async function run(input) {",
  "  const s = input.settings || {};",
  "  const r = input.paid || {};",
  "  if (!r.paid) return { message: null };",
  '  return { message: { text: "Paid " + Number(s.amount) + " USDC to " + String(s.payee || "").trim() + (r.txId ? " (receipt " + String(r.txId).slice(0, 12) + ")" : "") + "." } };',
  "}",
].join("\n");

export const payment: Recipe = {
  id: "payment",
  rev: 1,
  fits: "pay a saved payee a set amount of USDC on a schedule (every Friday, every month), asking the owner before each payment, then send a receipt",
  asks: { payee: "the saved payee's name", amount: "how much USDC each time" },
  uses: [],
  said: /\b(?:pay|pays|paying|payment|payments|usdc|send (?:him|her|them|my \w+) \$?\d)/i,
  variants: [],
  task: { says: "nothing: it pays, so leave it empty", byDefault: () => "" },
  build(f: RecipeFill) {
    const given = (key: string) => (f.given[key] ? { given: f.given[key] } : {});
    return {
      definition: {
        format: 1,
        name: f.name,
        job: { does: f.does, done: f.done },
        triggers: [f.trigger],
        settings: [
          { key: "payee", label: "Who it pays", type: "text", help: "A payee saved for this agent, by name.", choices: [], ...given("payee") },
          { key: "amount", label: "How much USDC each time", type: "number", help: "In USDC, like 0.5.", choices: [], ...given("amount") },
        ],
        rules: [],
        memory: [],
        steps: [
          {
            id: "prepare_payment",
            kind: "code",
            title: "Prepare the payment",
            plain: "Get the payment ready: who it pays and how much.",
            description: "Return payment, wallet.pay's arguments { to: settings.payee, amountUsdc: settings.amount, memo }.",
            inputs: ["settings"],
            outputs: ["payment"],
            shapes: { payment: "{ to: text, amountUsdc: number, memo: text }" },
            tools: [],
            next: "pay",
          },
          { id: "pay", kind: "action", title: "Pay, once you say yes", plain: "Pay it, after asking you first.", action: "pay", inputs: ["payment"], outputs: ["paid"], next: "write_receipt" },
          {
            id: "write_receipt",
            kind: "code",
            title: "Write the receipt",
            plain: "Note what was paid, to whom.",
            description: "Fill in one line with settings.amount, settings.payee and the receipt in paid, once it was paid. Return message, telegram.send's arguments { text }.",
            inputs: ["paid", "settings"],
            outputs: ["message"],
            shapes: { message: "{ text: text }" },
            tools: [],
            next: "send",
          },
          { id: "send", kind: "action", title: "Send you the receipt", plain: "Send you the receipt on Telegram.", action: "tell", inputs: ["message"], outputs: [], next: null },
        ],
        actions: [
          { id: "pay", tool: "wallet.pay", description: "Pay your payee the set amount, after asking you" },
          { id: "tell", tool: "telegram.send", description: "Send you the receipt" },
        ],
        limits: { maxSteps: 20, maxRunSeconds: 60, maxSpendUsd: 0.05 },
      },
      code: { prepare_payment: prepareCode, write_receipt: receiptCode },
    };
  },
  sample(d: AgentDefinition) {
    const bench = emptyBench();
    const setting = (k: string) => d.settings.find((s) => s.key === k)?.given;
    const payee = setting("payee") ?? "Designer";
    const amount = Number(setting("amount")) > 0 ? Number(setting("amount")) : 0.5;
    bench.settings = { payee, amount };
    bench.payees = [payee];
    bench.wallet = { balanceUsdc: Math.max(100, amount * 10) };
    bench.approve = "yes";
    return { bench, items: { noun: "payment", plural: "payments", labels: [`${amount} USDC to ${payee}`] } };
  },
};
