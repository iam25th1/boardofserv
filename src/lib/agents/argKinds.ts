import type { ToolName } from "./definition";
export { isDateText } from "../connections/reads";

// What a tool's arguments hold, beyond their types: a date, or an id. A
// string is a string to the type check, but GitHub's since takes a date,
// and an id passed there (a commit's sha remembered from the last run)
// fails every read after the first. Each call a step's code makes is read
// for what it passes to such an argument, traced back through the code's
// own variables and the agent's memory, and a value of the wrong kind is a
// problem with the code: the build writes it again (code.ts), and the
// review before publishing holds it (vetting.ts).

export type ArgKind = "date" | "id";

export const ARG_KINDS: Partial<Record<ToolName, Record<string, ArgKind>>> = {
  "github.read": { since: "date", sha: "id" },
  "shopify.read": { since: "date" },
};

export interface ArgMismatch {
  tool: ToolName;
  arg: string;
  wants: ArgKind;
  got: ArgKind;
  // What the code passes, as the code says it (for the code's writer).
  value: string;
}

type MemoryField = { key: string; description?: string };

// Names that say what a value is. A name that says both (sha_date) is a date.
const DATE_NAME = /(?:^|_)(?:date|dates|time|times|timestamp|since|until|when|iso|day|at)(?:$|_)|[a-z0-9](?:Date|Time|At|Since|Until|Timestamp)$|^(?:date|time|since|until|timestamp|when)$/i;
const ID_NAME = /(?:^|_)(?:sha|shas|hash|id|ids|uuid|oid|node_id)(?:$|_)|[a-z0-9](?:Sha|Id|Ids|Hash|Uuid)$|^(?:sha|id|hash|uuid)$/i;
const DATE_WORDS = /\b(?:date|time|timestamp|iso ?8601|iso date|when)\b/i;
const ID_WORDS = /\b(?:sha|hash|id|identifier)\b/i;
// Methods a value goes through unchanged in kind.
const SAME_KIND = new Set(["trim", "toString", "slice", "substring", "substr", "toLowerCase", "toUpperCase", "valueOf", "at", "replace", "padStart", "padEnd"]);
const ROOTS = new Set(["input", "memory", "settings", "rules", "trigger", "args", "params", "query", "options", "opts"]);
const KEYWORDS = /^(?:typeof|instanceof|String|Number|Boolean|Array|Object|JSON|Math|Date|null|undefined|true|false|await|new|return|if|else|const|let|var|in|of)$/;

const nameKind = (name: string): ArgKind | null => (DATE_NAME.test(name) ? "date" : ID_NAME.test(name) ? "id" : null);

// The code without its comments.
function bare(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

// The expression starting at i, up to a comma, a closing bracket, a
// semicolon or the end of the line at its own depth.
function exprAt(code: string, i: number): string {
  let depth = 0;
  let quote: string | null = null;
  let j = i;
  for (; j < code.length; j++) {
    const ch = code[j]!;
    if (quote) {
      if (ch === "\\") j++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && (ch === "," || ch === ";" || ch === "\n")) break;
  }
  return code.slice(i, j).trim();
}

// Every value the code gives an argument of this name: { since: x },
// { since }, args.since = x and args["since"] = x.
function valuesOf(code: string, arg: string): string[] {
  const out: string[] = [];
  const name = arg.replace(/[$]/g, "\\$");
  for (const m of code.matchAll(new RegExp(`(?<![\\w$.?])${name}\\s*:(?!:)`, "g"))) {
    const before = code.slice(0, m.index).trimEnd();
    // A ternary's other branch (a ? b : c) isn't an argument.
    if (/[?]$/.test(before)) continue;
    out.push(exprAt(code, m.index! + m[0].length));
  }
  for (const m of code.matchAll(new RegExp(`[{,]\\s*${name}\\s*(?=[,}])`, "g"))) out.push(arg);
  for (const m of code.matchAll(new RegExp(`(?:\\.\\s*${name}|\\[\\s*["'\`]${name}["'\`]\\s*\\])\\s*=(?![=>])`, "g"))) out.push(exprAt(code, m.index! + m[0].length));
  return out.filter(Boolean);
}

// What a variable of the code was given: its declarations and assignments.
function definitionsOf(code: string, name: string): string[] {
  const n = name.replace(/[$]/g, "\\$");
  const out: string[] = [];
  for (const m of code.matchAll(new RegExp(`\\b(?:const|let|var)\\s+${n}\\s*=(?![=>])`, "g"))) out.push(exprAt(code, m.index! + m[0].length));
  for (const m of code.matchAll(new RegExp(`(?<![\\w$.])${n}\\s*=(?![=>])`, "g"))) {
    const before = code.slice(Math.max(0, m.index! - 6), m.index);
    if (/\b(?:const|let|var)\s*$/.test(before)) continue;
    out.push(exprAt(code, m.index! + m[0].length));
  }
  return out;
}

interface Reader {
  code: string;
  memory: MemoryField[];
  // Every step's code, for what the agent writes into its memory.
  sources: string[];
  seen: Set<string>;
}

// The memory key an expression reads, if it reads one.
function memoryKeys(expr: string): string[] {
  const keys = new Set<string>();
  for (const m of expr.matchAll(/\bmemory\s*(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)/g)) if (m[1] !== "get" && m[1] !== "set") keys.add(m[1]!);
  for (const m of expr.matchAll(/\bmemory\s*(?:\?\.)?\[\s*["'`]([\w$]+)["'`]\s*\]/g)) keys.add(m[1]!);
  for (const m of expr.matchAll(/\bmemory\s*\.\s*get\s*\(\s*\{\s*key\s*:\s*["'`]([\w$]+)["'`]/g)) keys.add(m[1]!);
  return [...keys];
}

// What the agent keeps under a memory key: by its name, else what it says
// it holds, else what its code writes there.
function memoryKind(r: Reader, key: string, depth: number): ArgKind | null {
  const byName = nameKind(key);
  if (byName) return byName;
  const field = r.memory.find((f) => f.key === key);
  const said = field?.description ?? "";
  if (DATE_WORDS.test(said)) return "date";
  if (ID_WORDS.test(said)) return "id";
  if (depth > 3) return null;
  for (const src of r.sources) {
    const code = bare(src);
    const k = key.replace(/[$]/g, "\\$");
    for (const m of code.matchAll(new RegExp(`memory\\s*\\.\\s*set\\s*\\(\\s*\\{\\s*key\\s*:\\s*["'\`]${k}["'\`]\\s*,\\s*value\\s*:`, "g"))) {
      const got = kindOf({ ...r, code }, exprAt(code, m.index! + m[0].length), depth + 1);
      if (got) return got;
    }
  }
  return null;
}

// The kind of value an expression gives: a date, an id, or not known.
function kindOf(r: Reader, expr: string, depth = 0): ArgKind | null {
  if (depth > 4) return null;
  if (/\bnew\s+Date\b|\.toISOString\s*\(|\bDate\.now\b|\bDate\.UTC\b/.test(expr)) return "date";
  // Its memory keys first: they say what was kept.
  const kinds: ArgKind[] = [];
  for (const key of memoryKeys(expr)) {
    const k = memoryKind(r, key, depth);
    if (k) kinds.push(k);
  }
  // Every name in it: a property read for what it is called, a variable
  // for what the code gave it.
  const chains = expr.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, (s) => (/^["'`][\w$]+["'`]$/.test(s) ? s : '""')).matchAll(/[A-Za-z_$][\w$]*(?:\s*(?:\?\.|\.)\s*[A-Za-z_$][\w$]*|\s*\[\s*(?:\d+|["'`][\w$]+["'`])\s*\])*/g);
  for (const m of chains) {
    const parts = m[0].split(/\s*(?:\?\.|\.|\[)\s*/).map((p) => p.replace(/["'`\]\s]/g, "")).filter((p) => p && !/^\d+$/.test(p));
    // Words of the language, tool calls, and memory (read above).
    if (!parts.length || KEYWORDS.test(parts[0]!) || parts[0] === "tools") continue;
    if (parts[0] === "memory" || (parts[0] === "input" && parts[1] === "memory")) continue;
    const named = parts.filter((p) => !SAME_KIND.has(p));
    if (!named.length) continue;
    if (named.length === 1 && !ROOTS.has(named[0]!)) {
      // A variable: what the code gave it, not what it is called.
      const name = named[0]!;
      const defs = r.seen.has(name) ? [] : definitionsOf(r.code, name);
      if (defs.length) {
        r.seen.add(name);
        for (const def of defs) {
          const k = kindOf(r, def, depth + 1);
          if (k) kinds.push(k);
        }
        continue;
      }
    }
    const last = named.at(-1);
    const k = last && !ROOTS.has(last) ? nameKind(last) : null;
    if (k) kinds.push(k);
  }
  return kinds.includes("date") ? "date" : kinds.includes("id") ? "id" : null;
}

// The calls in a step's code that give an argument the wrong kind of value.
export function argMismatches(source: string, o: { memory?: readonly MemoryField[]; sources?: readonly string[] } = {}): ArgMismatch[] {
  const code = bare(source);
  const out: ArgMismatch[] = [];
  for (const [tool, args] of Object.entries(ARG_KINDS) as [ToolName, Record<string, ArgKind>][]) {
    const [group, name] = tool.split(".");
    if (!new RegExp(`\\btools\\s*\\.\\s*${group}\\s*\\.\\s*${name}\\s*\\(`).test(code)) continue;
    for (const [arg, wants] of Object.entries(args)) {
      for (const value of valuesOf(code, arg)) {
        const got = kindOf({ code, memory: [...(o.memory ?? [])], sources: [...(o.sources ?? [source])], seen: new Set() }, value);
        if (got && got !== wants && !out.some((x) => x.tool === tool && x.arg === arg && x.value === value)) out.push({ tool, arg, wants, got, value: value.slice(0, 120) });
      }
    }
  }
  return out;
}

// What is wrong, for the code's writer: what it passes, where, and how to
// put it right.
export function mismatchProblem(m: ArgMismatch): string {
  if (m.wants === "date") {
    return `It passes an id (${m.value}) as ${m.tool}'s ${m.arg}, which takes a date (ISO 8601, like 2026-11-16T09:00:00Z), so the service refuses every read after the first. Pass the date of the newest item it handled (and remember that date, not the item's sha or id), or read the newest items and stop at the one whose id it remembers.`;
  }
  return `It passes a date (${m.value}) as ${m.tool}'s ${m.arg}, which takes an id (a commit's sha, an item's id): pass the item's id.`;
}

// The same, for the maker, with no code in it.
export function mismatchFinding(m: ArgMismatch): string {
  const service = m.tool.split(".")[0]!;
  const name = service === "github" ? "GitHub" : service.charAt(0).toUpperCase() + service.slice(1);
  return m.wants === "date"
    ? `It passes an id where ${name} takes a date (the "${m.arg}" of its read), so every read after the first fails and later runs find nothing.`
    : `It passes a date where ${name} takes an id (the "${m.arg}" of its read), so that read fails.`;
}
