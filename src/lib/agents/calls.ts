import type { ToolName } from "./definition";

// A tool call in plain words, as the renter is asked about it: what it
// would do, with enough of what it carries to judge it.

const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 3)}...` : text);

export function describeCall(tool: ToolName, args: unknown): string {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v ?? ""));
  switch (tool) {
    case "telegram.send":
      return `Send you this message? "${clip(text(a.text), 400)}"`;
    case "telegram.ask":
      return `Ask you: "${clip(text(a.question), 400)}"`;
    case "sheets.write": {
      const rows = Array.isArray(a.rows) ? a.rows.length : 0;
      return `${a.mode === "replace" ? "Replace every row of" : `Add ${rows} ${rows === 1 ? "row" : "rows"} to`} "${clip(text(a.sheet), 80)}"${a.mode === "replace" ? ` with ${rows} ${rows === 1 ? "row" : "rows"}` : ""}?`;
    }
    case "memory.set":
      return `Remember "${clip(text(a.key), 40)}" for next time?`;
    case "wallet.pay":
      return `Pay ${typeof a.amountUsdc === "number" ? a.amountUsdc : "?"} USDC to ${clip(text(a.to), 120)}?`;
    case "web.fetch":
      return `Open ${clip(text(a.url), 200)}?`;
    case "web.search":
      return `Search the web for "${clip(text(a.query), 200)}"?`;
    default:
      return `Use ${tool}?`;
  }
}
