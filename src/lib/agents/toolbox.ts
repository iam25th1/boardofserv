import { z } from "zod";
import { SIDE_EFFECT_TOOLS, TOOL_NAMES, type ToolName } from "./definition";
import type { BenchData, SearchResult } from "./types";
import { keepRequired } from "../zodErrors";
import { sourceProblem, sourceRefusal } from "./sources";

// The kinds of field SERV can answer a reasoning call with.
export const REASON_TYPES = ["text", "number", "boolean", "list"] as const;
export type ReasonType = (typeof REASON_TYPES)[number];

// The toolbox: the only things a code step can reach, through the sandbox's
// host bridge. Each tool has typed arguments (checked here, whatever the
// code sends) and a result shape, written out for Dolphin as declarations.
// Here every tool is a mock that answers from the test bench's sample data,
// which the maker edits; a real job's tools (runtime/tools.ts) take the same
// calls to the owner's Google Sheets, Telegram, the web and web search.

const cell = z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]);
const row = z.record(z.string().max(80), cell);
export type Row = z.infer<typeof row>;

export const TOOL_ARGS = {
  "sheets.read": z.object({ sheet: z.string().min(1).max(80) }),
  "sheets.write": z.object({ sheet: z.string().min(1).max(80), rows: z.array(row).max(500), mode: z.enum(["append", "replace"]).optional() }),
  // Rows already in the sheet, each by its number (row 1 is the header), and
  // the named columns to write into it.
  "sheets.update": z.object({ sheet: z.string().min(1).max(80), updates: z.array(z.object({ row: z.number().int().min(2).max(100_000), values: row })).min(1).max(500) }),
  "web.fetch": z.object({ url: z.string().url().max(2000) }),
  "web.search": z.object({ query: z.string().min(1).max(300) }),
  "telegram.send": z.object({ text: z.string().min(1).max(4000) }),
  "telegram.ask": z.object({ question: z.string().min(1).max(2000), choices: z.array(z.string().max(80)).max(8).optional() }),
  "memory.get": z.object({ key: z.string().min(1).max(40) }),
  "memory.set": z.object({ key: z.string().min(1).max(40), value: z.unknown().optional() }),
  "wallet.pay": z.object({ to: z.string().min(1).max(120), amountUsdc: z.number().positive().max(100_000), memo: z.string().max(200).optional() }),
  // What SERV is asked, the values it works from, and the fields it answers
  // with, each of a type (text unless said): { text } when none are named.
  "serv.reason": z.object({
    task: z.string().min(1).max(2000),
    data: z.unknown().optional(),
    answer: z
      .record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/), z.enum(REASON_TYPES))
      .refine((a) => Object.keys(a).length >= 1 && Object.keys(a).length <= 8, "name 1 to 8 fields")
      .optional(),
  }),
} satisfies Record<ToolName, z.ZodTypeAny>;

// How much harm a tool's call can do, fixed here for each tool rather than
// guessed per run: read (looks, changes nothing), write (changes the
// owner's own data), outbound (says something to a person) and money
// (spends). A sheet write that records amounts counts as money (see
// risk.ts). The guard, approvals and the audit log go by it.
export const RISKS = ["read", "write", "outbound", "money"] as const;
export type Risk = (typeof RISKS)[number];

export interface ToolInfo {
  summary: string;
  // The declaration Dolphin writes against.
  signature: string;
  sideEffect: boolean;
  risk: Risk;
}

export const TOOLS: Record<ToolName, ToolInfo> = {
  "sheets.read": {
    summary: "Read every row of a sheet; each row has _row, its number in the sheet.",
    signature: "tools.sheets.read({ sheet: string }): Promise<{ rows: Array<Record<string, string | number | boolean | null> & { _row: number }> }>",
    sideEffect: false,
    risk: "read",
  },
  "sheets.write": {
    summary: "Add rows to a sheet, or replace all of its rows.",
    signature: 'tools.sheets.write({ sheet: string, rows: Array<Record<string, string | number | boolean | null>>, mode?: "append" | "replace" }): Promise<{ written: number }>',
    sideEffect: true,
    risk: "write",
  },
  "sheets.update": {
    summary: "Write named columns of rows already in a sheet, each row by its number (_row from sheets.read).",
    signature: "tools.sheets.update({ sheet: string, updates: Array<{ row: number, values: Record<string, string | number | boolean | null> }> }): Promise<{ updated: number }>",
    sideEffect: true,
    risk: "write",
  },
  "web.fetch": {
    summary: "Fetch a public web page's readable text (GET, http or https).",
    signature: "tools.web.fetch({ url: string }): Promise<{ status: number, text: string }>",
    sideEffect: false,
    risk: "read",
  },
  "web.search": {
    summary: "Search the web.",
    signature: "tools.web.search({ query: string }): Promise<{ results: Array<{ title: string, url: string, snippet: string }> }>",
    sideEffect: false,
    risk: "read",
  },
  "telegram.send": {
    summary: "Send the owner a message.",
    signature: "tools.telegram.send({ text: string }): Promise<{ sent: true }>",
    sideEffect: true,
    risk: "outbound",
  },
  "telegram.ask": {
    summary: "Ask the owner a question and wait for the answer (null when none comes).",
    signature: "tools.telegram.ask({ question: string, choices?: string[] }): Promise<{ answer: string | null }>",
    sideEffect: true,
    risk: "outbound",
  },
  "memory.get": {
    summary: "Read a value this agent remembered for this renter.",
    signature: "tools.memory.get({ key: string }): Promise<{ value: unknown }>",
    sideEffect: false,
    risk: "read",
  },
  "memory.set": {
    summary: "Remember a value for this renter, for the next job.",
    signature: "tools.memory.set({ key: string, value: unknown }): Promise<{ ok: true }>",
    sideEffect: false,
    risk: "write",
  },
  "wallet.pay": {
    summary: "Pay someone in USDC from the renter's wallet.",
    signature: "tools.wallet.pay({ to: string, amountUsdc: number, memo?: string }): Promise<{ paid: true, txId: string }>",
    sideEffect: true,
    risk: "money",
  },
  // A model call: it changes nothing, but it is metered like a decision.
  "serv.reason": {
    summary: "Ask SERV Reasoning to judge or write something at run time (a score with its reasons, a reply, a line for the day), from the data given.",
    signature:
      'tools.serv.reason({ task: string, data?: unknown, answer?: Record<string, "text" | "number" | "boolean" | "list"> }): Promise<Record<string, string | number | boolean | string[]>> // answers with exactly the fields named in answer ({ text } when none are named)',
    sideEffect: false,
    risk: "read",
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

// What an agent may remember: only the fields it declares, each holding
// its type (null forgets it), within a size. The same check on the bench
// and for real.
export const MAX_MEMORY_VALUE_BYTES = 20_000;
export const MAX_MEMORY_BYTES = 100_000;
type MemoryField = { key: string; type: "text" | "number" | "list" | "record" };

export function memoryProblem(fields: readonly MemoryField[], key: string, value: unknown): string | null {
  const field = fields.find((f) => f.key === key);
  if (!field) return `"${key}" isn't something this agent remembers${fields.length ? ` (it remembers ${fields.map((f) => f.key).join(", ")})` : ""}.`;
  if (value === null || value === undefined) return null;
  // A text field takes a short flag or count too ("true", 3): what code
  // writes there comes back as it was written.
  const ok =
    field.type === "text"
      ? typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))
      : field.type === "number"
        ? typeof value === "number" && Number.isFinite(value)
        : field.type === "list"
          ? Array.isArray(value)
          : typeof value === "object" && !Array.isArray(value);
  if (!ok) return `"${key}" holds ${field.type === "text" ? "text" : field.type === "number" ? "a number" : field.type === "list" ? "a list" : "a record (an object)"}.`;
  if (JSON.stringify(value).length > MAX_MEMORY_VALUE_BYTES) return `"${key}" is too large to remember (over ${MAX_MEMORY_VALUE_BYTES / 1000} KB).`;
  return null;
}

// A row as written to a sheet: a row's number (_row, from sheets.read) is
// where it is, never a column of its own.
export function withoutRowNumber<T extends Record<string, unknown>>(r: T): T {
  return Object.fromEntries(Object.entries(r).filter(([k]) => k !== "_row")) as T;
}

// The mocks: one set per run, on a copy of the bench's data, so a run can
// write sheets, remember values and pay without changing the bench. Every
// call is logged for the test bench.
export class MockTools {
  readonly calls: ToolCall[] = [];
  private data: BenchData;
  private asked = 0;
  private paid = 0;

  // With memory fields, memory.get and memory.set keep to them, as for real.
  constructor(
    bench: BenchData,
    private memoryFields?: readonly MemoryField[],
  ) {
    this.data = structuredClone(bench);
  }

  get memory(): Record<string, unknown> {
    return this.data.memory;
  }

  get sheets(): BenchData["sheets"] {
    return this.data.sheets;
  }

  // What the stand-in tools hold now, to keep for a job's next run.
  get kept(): Pick<BenchData, "sheets" | "search" | "wallet"> {
    return { sheets: this.data.sheets, search: this.data.search, wallet: this.data.wallet };
  }

  async call(tool: ToolName, rawArgs: unknown): Promise<unknown> {
    const parsed = TOOL_ARGS[tool].safeParse(rawArgs, { error: keepRequired });
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
        // Each row with its number in the sheet, as Google's rows are: the
        // header is row 1.
        return { rows: structuredClone(rows).map((r, i) => ({ ...r, _row: i + 2 })) };
      }
      case "sheets.write": {
        const a = args as z.infer<(typeof TOOL_ARGS)["sheets.write"]>;
        const rows = a.rows.map(withoutRowNumber);
        d.sheets[a.sheet] = a.mode === "replace" ? rows : [...(d.sheets[a.sheet] ?? []), ...rows];
        return { written: a.rows.length };
      }
      case "sheets.update": {
        const a = args as z.infer<(typeof TOOL_ARGS)["sheets.update"]>;
        const rows = d.sheets[a.sheet];
        if (!rows) throw new ToolError(tool, `There is no sheet called "${a.sheet}".`);
        for (const u of a.updates) if (!rows[u.row - 2]) throw new ToolError(tool, `"${a.sheet}" has no row ${u.row}: it has rows 2 to ${rows.length + 1}.`);
        for (const u of a.updates) rows[u.row - 2] = { ...rows[u.row - 2], ...withoutRowNumber(u.values) };
        return { updated: a.updates.length };
      }
      case "web.fetch": {
        const a = args as z.infer<(typeof TOOL_ARGS)["web.fetch"]>;
        // As for real: a form's link or a page behind a sign-in can't be read.
        const unreadable = sourceProblem(a.url);
        if (unreadable) throw new ToolError(tool, sourceRefusal(unreadable));
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
        const why = this.memoryFields ? memoryProblem(this.memoryFields, a.key, null) : null;
        if (why) throw new ToolError(tool, why);
        return { value: d.memory[a.key] ?? null };
      }
      case "memory.set": {
        const a = args as z.infer<(typeof TOOL_ARGS)["memory.set"]>;
        const why = this.memoryFields ? memoryProblem(this.memoryFields, a.key, a.value) : null;
        if (why) throw new ToolError(tool, why);
        d.memory[a.key] = a.value ?? null;
        return { ok: true };
      }
      case "wallet.pay": {
        const a = args as z.infer<(typeof TOOL_ARGS)["wallet.pay"]>;
        // Only saved payees, by name or address, as for real.
        if (d.payees && !d.payees.some((p) => p.trim().toLowerCase() === a.to.trim().toLowerCase())) throw new ToolError(tool, `"${a.to.slice(0, 60)}" isn't one of this renter's saved payees, so nothing was paid. It can only pay saved payees.`);
        if (a.amountUsdc > d.wallet.balanceUsdc) throw new ToolError(tool, `Not enough USDC: ${d.wallet.balanceUsdc} left, ${a.amountUsdc} asked.`);
        d.wallet.balanceUsdc = Math.round((d.wallet.balanceUsdc - a.amountUsdc) * 1e6) / 1e6;
        this.paid += 1;
        return { paid: true, txId: `mock-${this.paid}` };
      }
      case "serv.reason":
        return standInReason(args as z.infer<(typeof TOOL_ARGS)["serv.reason"]>);
    }
    throw new ToolError(tool, `${tool} is not a tool.`);
  }
}

// A dry run's stand-in for SERV's reasoning: the fields asked for, each of
// its type, made from the data so two different items get different
// answers (a number from 1 to 10). Never presented as SERV's own words.
export function standInReason(args: { task: string; data?: unknown; answer?: Record<string, ReasonType> }): Record<string, unknown> {
  const text = JSON.stringify(args.data ?? null);
  let h = 0x811c9dc5;
  for (const ch of `${args.task}\n${text}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  const fields = args.answer ?? { text: "text" as const };
  return Object.fromEntries(
    Object.entries(fields).map(([k, type], i) => {
      const n = (h >>> (i * 3)) % 10;
      if (type === "number") return [k, n + 1];
      if (type === "boolean") return [k, n % 2 === 0];
      if (type === "list") return [k, [`Dry run: SERV gives ${k} here on a live run.`]];
      return [k, `Dry run: SERV writes ${k} here on a live run.`];
    }),
  );
}

// The bridge's gate: a code step reaches only the tools it lists, whatever
// name its code passes.
export function gate(allowed: readonly ToolName[], name: unknown): ToolName {
  if (typeof name !== "string" || !isToolName(name)) throw new ToolError(String(name).slice(0, 40), `${String(name).slice(0, 40)} is not a tool.`);
  if (!allowed.includes(name)) throw new ToolError(name, `This step may not use ${name}.`);
  return name;
}

// The bench's sample data as the builder sends it: anything JSON, within
// reason, in the shape the mocks read.
const json = z.unknown().refine((v) => JSON.stringify(v ?? null).length <= 200_000, "too large");
export const BenchSchema = z.object({
  settings: z.record(z.string(), z.unknown()),
  rules: z.record(z.string(), z.string().max(200)),
  trigger: z.record(z.string(), z.unknown()).nullable(),
  sheets: z.record(z.string(), z.array(z.record(z.string(), z.unknown())).max(500)),
  pages: z.record(z.string(), z.string().max(50_000)),
  search: z.record(z.string(), z.array(z.object({ title: z.string().max(300), url: z.string().max(2000), snippet: z.string().max(2000) })).max(20)),
  telegram: z.object({ answers: z.array(z.string().max(2000)).max(20) }),
  memory: z.record(z.string(), z.unknown()),
  wallet: z.object({ balanceUsdc: z.number().min(0).max(1_000_000) }),
  decisions: z.record(z.string(), z.string().max(40)),
  payees: z.array(z.string().max(120)).max(20).optional(),
  approve: z.enum(["yes", "no"]).optional(),
}).refine((b) => json.safeParse(b).success, "The sample data is too large.");
