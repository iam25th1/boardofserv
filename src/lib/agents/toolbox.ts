import { z } from "zod";
import { SIDE_EFFECT_TOOLS, TOOL_NAMES, type ToolName } from "./definition";
import type { BenchData, SearchResult } from "./types";

// The toolbox: the only things a code step can reach, through the sandbox's
// host bridge. Each tool has typed arguments (checked here, whatever the
// code sends) and a result shape, written out for Dolphin as declarations.
// Real implementations come in later phases; for now every tool is a mock
// that answers from the test bench's sample data, which the maker edits.

const cell = z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]);
const row = z.record(z.string().max(80), cell);
export type Row = z.infer<typeof row>;

export const TOOL_ARGS = {
  "sheets.read": z.object({ sheet: z.string().min(1).max(80) }),
  "sheets.write": z.object({ sheet: z.string().min(1).max(80), rows: z.array(row).max(500), mode: z.enum(["append", "replace"]).optional() }),
  "web.fetch": z.object({ url: z.string().url().max(2000) }),
  "web.search": z.object({ query: z.string().min(1).max(300) }),
  "telegram.send": z.object({ text: z.string().min(1).max(4000) }),
  "telegram.ask": z.object({ question: z.string().min(1).max(2000), choices: z.array(z.string().max(80)).max(8).optional() }),
  "memory.get": z.object({ key: z.string().min(1).max(40) }),
  "memory.set": z.object({ key: z.string().min(1).max(40), value: z.unknown() }),
  "wallet.pay": z.object({ to: z.string().min(1).max(120), amountUsdc: z.number().positive().max(100_000), memo: z.string().max(200).optional() }),
} satisfies Record<ToolName, z.ZodTypeAny>;

export interface ToolInfo {
  summary: string;
  // The declaration Dolphin writes against.
  signature: string;
  sideEffect: boolean;
}

export const TOOLS: Record<ToolName, ToolInfo> = {
  "sheets.read": {
    summary: "Read every row of a sheet.",
    signature: "tools.sheets.read({ sheet: string }): Promise<{ rows: Array<Record<string, string | number | boolean | null>> }>",
    sideEffect: false,
  },
  "sheets.write": {
    summary: "Add rows to a sheet, or replace all of its rows.",
    signature: 'tools.sheets.write({ sheet: string, rows: Array<Record<string, string | number | boolean | null>>, mode?: "append" | "replace" }): Promise<{ written: number }>',
    sideEffect: true,
  },
  "web.fetch": {
    summary: "Fetch a web page's text.",
    signature: "tools.web.fetch({ url: string }): Promise<{ status: number, text: string }>",
    sideEffect: false,
  },
  "web.search": {
    summary: "Search the web.",
    signature: "tools.web.search({ query: string }): Promise<{ results: Array<{ title: string, url: string, snippet: string }> }>",
    sideEffect: false,
  },
  "telegram.send": {
    summary: "Send the owner a message.",
    signature: "tools.telegram.send({ text: string }): Promise<{ sent: true }>",
    sideEffect: true,
  },
  "telegram.ask": {
    summary: "Ask the owner a question and wait for the answer (null when none comes).",
    signature: "tools.telegram.ask({ question: string, choices?: string[] }): Promise<{ answer: string | null }>",
    sideEffect: true,
  },
  "memory.get": {
    summary: "Read a value this agent remembered for this renter.",
    signature: "tools.memory.get({ key: string }): Promise<{ value: unknown }>",
    sideEffect: false,
  },
  "memory.set": {
    summary: "Remember a value for this renter, for the next job.",
    signature: "tools.memory.set({ key: string, value: unknown }): Promise<{ ok: true }>",
    sideEffect: false,
  },
  "wallet.pay": {
    summary: "Pay someone in USDC from the renter's wallet.",
    signature: "tools.wallet.pay({ to: string, amountUsdc: number, memo?: string }): Promise<{ paid: true, txId: string }>",
    sideEffect: true,
  },
};

// The declarations for these tools, one per line, for Dolphin's prompt.
export function toolTypes(names: readonly ToolName[]): string {
  return names.length ? names.map((n) => TOOLS[n].signature).join("\n") : "(no tools: this step works only on its input)";
}

export function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

export function hasSideEffect(name: ToolName): boolean {
  return SIDE_EFFECT_TOOLS.includes(name);
}

// A tool call that failed: the message goes back to the step's code as an
// error, in plain words.
export class ToolError extends Error {
  readonly tool: string;
  constructor(tool: string, message: string) {
    super(message);
    this.name = "ToolError";
    this.tool = tool;
  }
}

export interface ToolCall {
  tool: ToolName;
  args: unknown;
  result: unknown;
  error: string | null;
}

// The mocks: one set per run, on a copy of the bench's data, so a run can
// write sheets, remember values and pay without changing the bench. Every
// call is logged for the test bench.
export class MockTools {
  readonly calls: ToolCall[] = [];
  private data: BenchData;
  private asked = 0;
  private paid = 0;

  constructor(bench: BenchData) {
    this.data = structuredClone(bench);
  }

  get memory(): Record<string, unknown> {
    return this.data.memory;
  }

  get sheets(): BenchData["sheets"] {
    return this.data.sheets;
  }

  async call(tool: ToolName, rawArgs: unknown): Promise<unknown> {
    const parsed = TOOL_ARGS[tool].safeParse(rawArgs);
    if (!parsed.success) {
      const why = parsed.error.issues.map((i) => `${i.path.join(".") || "arguments"} ${i.message.toLowerCase()}`).join("; ");
      this.calls.push({ tool, args: rawArgs, result: null, error: why });
      throw new ToolError(tool, `${tool} was called wrongly: ${why}`);
    }
    try {
      const result = this.answer(tool, parsed.data as never);
      this.calls.push({ tool, args: parsed.data, result, error: null });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : `${tool} failed`;
      this.calls.push({ tool, args: parsed.data, result: null, error: message });
      throw err instanceof ToolError ? err : new ToolError(tool, message);
    }
  }

  private answer<T extends ToolName>(tool: T, args: z.infer<(typeof TOOL_ARGS)[T]>): unknown {
    const d = this.data;
    switch (tool) {
      case "sheets.read": {
        const a = args as z.infer<(typeof TOOL_ARGS)["sheets.read"]>;
        const rows = d.sheets[a.sheet];
        if (!rows) throw new ToolError(tool, `There is no sheet called "${a.sheet}".`);
        return { rows: structuredClone(rows) };
      }
      case "sheets.write": {
        const a = args as z.infer<(typeof TOOL_ARGS)["sheets.write"]>;
        d.sheets[a.sheet] = a.mode === "replace" ? a.rows : [...(d.sheets[a.sheet] ?? []), ...a.rows];
        return { written: a.rows.length };
      }
      case "web.fetch": {
        const a = args as z.infer<(typeof TOOL_ARGS)["web.fetch"]>;
        const text = d.pages[a.url];
        return text === undefined ? { status: 404, text: "" } : { status: 200, text };
      }
      case "web.search": {
        const a = args as z.infer<(typeof TOOL_ARGS)["web.search"]>;
        const results: SearchResult[] = d.search[a.query] ?? d.search["*"] ?? [];
        return { results: structuredClone(results) };
      }
      case "telegram.send":
        return { sent: true };
      case "telegram.ask": {
        const answer = d.telegram.answers[this.asked] ?? null;
        this.asked += 1;
        return { answer };
      }
      case "memory.get": {
        const a = args as z.infer<(typeof TOOL_ARGS)["memory.get"]>;
        return { value: d.memory[a.key] ?? null };
      }
      case "memory.set": {
        const a = args as z.infer<(typeof TOOL_ARGS)["memory.set"]>;
        d.memory[a.key] = a.value ?? null;
        return { ok: true };
      }
      case "wallet.pay": {
        const a = args as z.infer<(typeof TOOL_ARGS)["wallet.pay"]>;
        if (a.amountUsdc > d.wallet.balanceUsdc) throw new ToolError(tool, `Not enough USDC: ${d.wallet.balanceUsdc} left, ${a.amountUsdc} asked.`);
        d.wallet.balanceUsdc = Math.round((d.wallet.balanceUsdc - a.amountUsdc) * 1e6) / 1e6;
        this.paid += 1;
        return { paid: true, txId: `mock-${this.paid}` };
      }
    }
    throw new ToolError(tool, `${tool} is not a tool.`);
  }
}

// The bridge's gate: a code step reaches only the tools it lists, whatever
// name its code passes.
export function gate(allowed: readonly ToolName[], name: unknown): ToolName {
  if (typeof name !== "string" || !isToolName(name)) throw new ToolError(String(name).slice(0, 40), `${String(name).slice(0, 40)} is not a tool.`);
  if (!allowed.includes(name)) throw new ToolError(name, `This step may not use ${name}.`);
  return name;
}
