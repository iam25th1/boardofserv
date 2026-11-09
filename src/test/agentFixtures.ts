import type { BenchData } from "@/lib/agents/types";

// A fabric shop's restock agent, as SERV's plan answers it (the flat wire
// shape of AGENT_PLAN_SCHEMA), with sample bench data and code for each
// step. Shared by the agent tests; every model is mocked.

export const RESTOCK_WIRE = {
  name: "Fabric restock",
  job: { does: "Checks the stock sheet each morning and orders low fabrics from the best of three suppliers.", done: "Every low fabric has an order recorded, or the owner said no." },
  triggers: [{ kind: "schedule", every: "day", at: "08:00", everyMinutes: 0, watch: "", when: "", description: "Every morning at eight" }],
  settings: [
    { key: "stock_sheet", label: "Which sheet holds your stock?", type: "sheet", help: "Rows with fabric, metres in stock and the minimum.", choices: [] },
    { key: "orders_sheet", label: "Where should orders go?", type: "sheet", help: "Each order is added as a row.", choices: [] },
    { key: "suppliers_sheet", label: "Which sheet lists your suppliers?", type: "sheet", help: "Rows with supplier, fabric, price_usdc and delivery_days.", choices: [] },
  ],
  rules: [
    { key: "approval_over_usdc", label: "Ask me before orders over", type: "usdc", value: "250", help: "Orders over this wait for your yes." },
    { key: "max_delivery_days", label: "Longest delivery", type: "number", value: "7", help: "Suppliers slower than this are skipped." },
  ],
  memory: [{ key: "last_order", description: "The last order placed", type: "record" }],
  actions: [
    { id: "ask_owner", tool: "telegram.ask", description: "Ask the owner before a big order" },
    { id: "record_order", tool: "sheets.write", description: "Add the order to the orders sheet" },
  ],
  steps: [
    { id: "find_low", title: "Find low stock", kind: "code", inputs: ["settings"], outputs: ["low"], next: "compare", description: "Read the stock sheet named in settings.stock_sheet and return low: the rows whose metres are below their minimum.", tools: ["sheets.read"], prompt: "", outcomes: [], action: "" },
    { id: "compare", title: "Compare suppliers", kind: "code", inputs: ["low", "rules", "settings"], outputs: ["order", "order_rows"], next: "check_total", description: "Read the suppliers sheet named in settings.suppliers_sheet. For each low fabric pick the cheapest supplier whose delivery_days is at most rules.max_delivery_days, order enough metres to reach twice the minimum, and return order: { lines, total_usdc } and order_rows: { sheet: settings.orders_sheet, rows } with one row per line.", tools: ["sheets.read"], prompt: "", outcomes: [], action: "" },
    { id: "check_total", title: "Big order?", kind: "decision", inputs: ["order", "rules"], outputs: [], next: "", description: "", tools: [], prompt: "Is order.total_usdc over rules.approval_over_usdc?", outcomes: [{ id: "over", label: "Over the limit", next: "ask_owner" }, { id: "within", label: "Within the limit", next: "record" }], action: "" },
    { id: "ask_owner", title: "Ask the owner", kind: "action", inputs: ["order"], outputs: ["answer"], next: "approved", description: "", tools: [], prompt: "", outcomes: [], action: "ask_owner" },
    { id: "approved", title: "Owner said yes?", kind: "decision", inputs: ["answer"], outputs: [], next: "", description: "", tools: [], prompt: "Did the owner agree to the order?", outcomes: [{ id: "yes", label: "Yes", next: "record" }, { id: "no", label: "No", next: "" }], action: "" },
    { id: "record", title: "Record the order", kind: "action", inputs: ["order_rows"], outputs: ["recorded"], next: "", description: "", tools: [], prompt: "", outcomes: [], action: "record_order" },
  ],
  limits: { maxSteps: 20, maxRunSeconds: 60, maxSpendUsd: 0.05 },
};

export const FIND_LOW = `async function run(input, tools) {
  const { rows } = await tools.sheets.read({ sheet: input.settings.stock_sheet });
  return { low: rows.filter((r) => Number(r.metres) < Number(r.minimum)) };
}`;

export const COMPARE = `async function run(input, tools) {
  const { rows } = await tools.sheets.read({ sheet: input.settings.suppliers_sheet });
  const maxDays = Number(input.rules.max_delivery_days);
  const lines = [];
  for (const fabric of input.low) {
    const offers = rows.filter((s) => s.fabric === fabric.fabric && Number(s.delivery_days) <= maxDays);
    if (!offers.length) continue;
    offers.sort((a, b) => Number(a.price_usdc) - Number(b.price_usdc));
    const best = offers[0];
    const metres = Number(fabric.minimum) * 2 - Number(fabric.metres);
    lines.push({ fabric: fabric.fabric, supplier: best.supplier, metres, cost_usdc: Math.round(metres * Number(best.price_usdc) * 100) / 100 });
  }
  const total = Math.round(lines.reduce((t, l) => t + l.cost_usdc, 0) * 100) / 100;
  const orderRows = lines.map((l) => ({ fabric: l.fabric, supplier: l.supplier, metres: l.metres, cost_usdc: l.cost_usdc }));
  return { order: { lines, total_usdc: total }, order_rows: { sheet: input.settings.orders_sheet, rows: orderRows } };
}`;

export function restockBench(): BenchData {
  return {
    settings: { stock_sheet: "Stock", orders_sheet: "Orders", suppliers_sheet: "Suppliers" },
    rules: {},
    trigger: null,
    sheets: {
      Stock: [
        { fabric: "Linen, natural", metres: 4, minimum: 20 },
        { fabric: "Cotton twill", metres: 55, minimum: 30 },
        { fabric: "Wool felt", metres: 6, minimum: 10 },
      ],
      Suppliers: [
        { supplier: "Northmill Textiles", fabric: "Linen, natural", price_usdc: 6.5, delivery_days: 3 },
        { supplier: "Harbor Cloth Co.", fabric: "Linen, natural", price_usdc: 5.9, delivery_days: 9 },
        { supplier: "Weftworks", fabric: "Linen, natural", price_usdc: 6.1, delivery_days: 5 },
        { supplier: "Northmill Textiles", fabric: "Wool felt", price_usdc: 11, delivery_days: 4 },
        { supplier: "Weftworks", fabric: "Wool felt", price_usdc: 10.5, delivery_days: 6 },
      ],
      Orders: [],
    },
    pages: {},
    search: {},
    telegram: { answers: ["yes"] },
    memory: {},
    wallet: { balanceUsdc: 500 },
    decisions: { check_total: "within", approved: "yes" },
  };
}
