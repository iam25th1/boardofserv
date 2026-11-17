import type { AgentDefinition } from "../definition";
import { emptyBench } from "../types";
import type { Recipe, RecipeFill } from "./types";

// A daily or weekly summary of a sheet: the rows of the last day or week
// (by the sheet's date column, when it has one), how many there were and
// each number column's total, in one message. The offline suite's "Daily
// sales total" plan, which goes live every time, made for any sheet: code
// adds up, so the totals are exact, and no model is needed.

const periodCode = (days: number) =>
  [
    "async function run(input, tools) {",
    '  const sheet = (input.settings || {}).sheet;',
    "  if (!sheet) return { totals: null };",
    "  const got = await tools.sheets.read({ sheet: sheet });",
    "  const rows = got && Array.isArray(got.rows) ? got.rows : [];",
    "  const columns = rows.length ? Object.keys(rows[0]).filter(function (k) { return k !== \"_row\"; }) : [];",
    "  const dated = columns.find(function (k) { return /date|day|when|time/i.test(k); });",
    "  const since = new Date();",
    `  since.setDate(since.getDate() - ${days});`,
    "  const kept = dated ? rows.filter(function (r) { const t = new Date(String(r[dated])); return !isNaN(t.getTime()) && t > since; }) : rows;",
    '  const amount = function (v) { const n = Number(String(v === null || v === undefined ? "" : v).replace(/[$,\\s]/g, "")); return String(v === null || v === undefined ? "" : v).trim() !== "" && isFinite(n) ? n : null; };',
    "  const sums = [];",
    "  for (const k of columns) {",
    "    if (k === dated) continue;",
    "    const values = kept.map(function (r) { return amount(r[k]); }).filter(function (n) { return n !== null; });",
    "    if (values.length && values.length === kept.filter(function (r) { return String(r[k] === null || r[k] === undefined ? \"\" : r[k]).trim() !== \"\"; }).length) {",
    "      sums.push({ column: k, total: Math.round(values.reduce(function (a, b) { return a + b; }, 0) * 100) / 100 });",
    "    }",
    "  }",
    `  return { totals: { rows: kept.length, sums: sums, days: ${days} } };`,
    "}",
  ].join("\n");

const messageCode = [
  "async function run(input) {",
  "  const t = input.totals;",
  "  if (!t) return { message: null };",
  '  const span = t.days === 1 ? "today" : "this week";',
  '  const head = t.rows === 1 ? "1 row " + span : t.rows + " rows " + span;',
  '  const parts = t.sums.map(function (s) { return s.column + " " + s.total; });',
  '  return { message: { text: head + (parts.length ? ": " + parts.join(", ") + "." : ".") } };',
  "}",
].join("\n");

export const summary: Recipe = {
  id: "summary",
  rev: 1,
  fits: "a daily or weekly summary of a Google Sheet (sales, orders, sign-ups): how many rows in the period and each number column's total, in one message",
  asks: { sheet: "the Google Sheet tab it sums up" },
  uses: ["google"],
  variants: [
    { id: "day", says: "the last day's rows (a daily summary)" },
    { id: "week", says: "the last 7 days' rows (a weekly summary)" },
  ],
  task: { says: "nothing: it adds up, so leave it empty", byDefault: () => "" },
  build(f: RecipeFill) {
    const days = f.variant === "week" ? 7 : 1;
    return {
      definition: {
        format: 1,
        name: f.name,
        job: { does: f.does, done: f.done },
        triggers: [f.trigger],
        settings: [{ key: "sheet", label: "Which sheet it sums up", type: "sheet", help: "One row each, with a date column and number columns (an Amount).", choices: [], ...(f.given.sheet ? { given: f.given.sheet } : {}) }],
        rules: [],
        memory: [],
        steps: [
          {
            id: "add_up",
            kind: "code",
            title: days === 1 ? "Add up today's rows" : "Add up this week's rows",
            plain: `Read your sheet and add up the rows of the last ${days === 1 ? "day" : "7 days"}.`,
            description: `Read the sheet in settings.sheet with sheets.read, keep the rows of the last ${days === 1 ? "day" : "7 days"} by its date column (all of them when it has none), count them and total each number column. Return totals { rows, sums: [{ column, total }], days }.`,
            inputs: ["settings"],
            outputs: ["totals"],
            shapes: { totals: "{ rows: number, sums: { column: text, total: number }[], days: number }" },
            tools: ["sheets.read"],
            next: "write_summary",
          },
          {
            id: "write_summary",
            kind: "code",
            title: "Write the summary",
            plain: "Put the count and the totals in one line.",
            description: "Fill in one line with how many rows there were and each column's total. Return message, telegram.send's arguments { text }.",
            inputs: ["totals"],
            outputs: ["message"],
            shapes: { message: "{ text: text }" },
            tools: [],
            next: "send",
          },
          { id: "send", kind: "action", title: "Send it to you", plain: "Send it to you on Telegram.", action: "tell", inputs: ["message"], outputs: [], next: null },
        ],
        actions: [{ id: "tell", tool: "telegram.send", description: "Send you the summary" }],
        limits: { maxSteps: 20, maxRunSeconds: 60, maxSpendUsd: 0.05 },
      },
      code: { add_up: periodCode(days), write_summary: messageCode },
    };
  },
  sample(d: AgentDefinition) {
    const bench = emptyBench();
    const tab = d.settings.find((s) => s.key === "sheet")?.given ?? "Sales";
    bench.settings.sheet = tab;
    // Two rows in the period and one before it, by hours ago.
    const ago = /today/i.test(d.steps[0]?.title ?? "") ? [2, 5, 30] : [48, 120, 480];
    const at = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
    bench.sheets[tab] = [
      { Date: at(ago[0]!), Item: "Linen apron", Amount: "24.50" },
      { Date: at(ago[1]!), Item: "Tea towel", Amount: "9.00" },
      { Date: at(ago[2]!), Item: "Tote bag", Amount: "18.00" },
    ];
    return { bench, items: { noun: "sale", plural: "sales", labels: ["Linen apron", "Tea towel", "Tote bag"] } };
  },
};
