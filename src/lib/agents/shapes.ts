import { ARGS_TOOLS, RUN_VALUES, type AgentDefinition, type AgentStep, type ToolName } from "./definition";
import type { RunEvent } from "./types";

// What passes between steps. Each step says the shape of what it makes
// (its outputs' shapes, in the plan), and the shapes are checked against
// what reads them before anything is built: an action is handed exactly
// its tool's arguments, a loop goes through a list, a step reads only the
// fields the value it reads has. A step whose code then makes something
// else fails its self test, and the build heals it.
//
// A shape is written plainly: text, number, boolean, a list of a shape
// with [] after it, or an object, { name, score: number, reasons } (a
// field with no type is text), with ... for "and other fields". Anything
// else reads as any shape.

export type Shape =
  | { t: "text" | "number" | "boolean" | "any" | "null" }
  | { t: "list"; of: Shape }
  | { t: "object"; fields: Record<string, Shape>; open: boolean };

const ANY: Shape = { t: "any" };

export function parseShape(text: string | undefined | null): Shape {
  if (!text) return ANY;
  let i = 0;
  const src = text.trim();
  const space = () => {
    while (i < src.length && /\s/.test(src[i]!)) i++;
  };
  const word = () => {
    space();
    const m = /^[A-Za-z_][A-Za-z0-9_ ]*/.exec(src.slice(i));
    if (!m) return "";
    i += m[0].length;
    return m[0].trim();
  };
  const one = (): Shape => {
    space();
    let shape: Shape;
    if (src[i] === "{") {
      i++;
      const fields: Record<string, Shape> = {};
      let open = false;
      for (;;) {
        space();
        if (src[i] === "}") {
          i++;
          break;
        }
        if (src.startsWith("...", i)) {
          open = true;
          i += 3;
        } else {
          const name = word();
          if (!name) return ANY;
          space();
          let field: Shape = { t: "text" };
          if (src[i] === "?") i++;
          space();
          if (src[i] === ":") {
            i++;
            field = one();
          }
          fields[name.replace(/\s+/g, "_")] = field;
        }
        space();
        if (src[i] === ",") i++;
        else if (src[i] !== "}") return ANY;
      }
      shape = { t: "object", fields, open };
    } else {
      const w = word().toLowerCase();
      shape =
        w === "text" || w === "string"
          ? { t: "text" }
          : w === "number" || w === "integer" || w === "usdc"
            ? { t: "number" }
            : w === "boolean" || w === "bool"
              ? { t: "boolean" }
              : w === "null"
                ? { t: "null" }
                : w === "list" || w === "array"
                  ? { t: "list", of: ANY }
                  : w === "object" || w === "record"
                    ? { t: "object", fields: {}, open: true }
                    : ANY;
    }
    space();
    while (src.startsWith("[]", i)) {
      shape = { t: "list", of: shape };
      i += 2;
      space();
    }
    // "x or null": the value may be missing (nothing to do).
    if (/^or\s+null\b/i.test(src.slice(i))) i += /^or\s+null/i.exec(src.slice(i))![0].length;
    return shape;
  };
  const shape = one();
  space();
  return i >= src.length ? shape : ANY;
}

export function showShape(s: Shape): string {
  if (s.t === "list") return `${showShape(s.of)}[]`;
  if (s.t === "object") return `{ ${[...Object.entries(s.fields).map(([k, v]) => (v.t === "text" ? k : `${k}: ${showShape(v)}`)), ...(s.open ? ["..."] : [])].join(", ")} }`;
  return s.t;
}

// Why a value doesn't have the shape, or null when it does (null and a
// missing value always fit: nothing to do).
export function misfit(value: unknown, s: Shape, at = ""): string | null {
  if (value === null || value === undefined || s.t === "any") return null;
  const where = at ? `${at} ` : "";
  if (s.t === "null") return null;
  if (s.t === "text") return typeof value === "string" || typeof value === "number" ? null : `${where}is ${kind(value)}, not text`;
  if (s.t === "number") return typeof value === "number" || (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) ? null : `${where}is ${kind(value)}, not a number`;
  if (s.t === "boolean") return typeof value === "boolean" ? null : `${where}is ${kind(value)}, not true or false`;
  if (s.t === "list") {
    if (!Array.isArray(value)) return `${where}is ${kind(value)}, not a list`;
    for (let n = 0; n < Math.min(value.length, 20); n++) {
      const why = misfit(value[n], s.of, `${at || "it"}[${n}]`);
      if (why) return why;
    }
    return null;
  }
  if (s.t !== "object") return null;
  if (typeof value !== "object" || Array.isArray(value)) return `${where}is ${kind(value)}, not an object`;
  for (const [k, f] of Object.entries(s.fields)) {
    const v = (value as Record<string, unknown>)[k];
    if (!(k in (value as object))) return `${at ? `${at}.` : ""}${k} is missing`;
    const why = misfit(v, f, `${at ? `${at}.` : ""}${k}`);
    if (why) return why;
  }
  return null;
}

const kind = (v: unknown) => (Array.isArray(v) ? "a list" : v === null ? "nothing" : typeof v === "object" ? "an object" : typeof v === "string" ? "text" : typeof v === "number" ? "a number" : typeof v);

// What each action's tool must be handed, as a shape.
const TOOL_SHAPES: Partial<Record<ToolName, Shape>> = {
  "telegram.send": parseShape("{ text }"),
  "telegram.ask": parseShape("{ question, ... }"),
  "sheets.write": parseShape("{ sheet, rows: object[], ... }"),
  "sheets.update": parseShape("{ sheet, updates: { row: number, values: object }[] }"),
  "wallet.pay": parseShape("{ to, amountUsdc: number, ... }"),
  "memory.set": parseShape("{ key, value: any }"),
};

// The declared shape of a value a step reads: what the step that makes it
// said, a loop's item (one entry of its list), or a gathered list.
export function shapeOf(d: AgentDefinition, name: string): Shape {
  if ((RUN_VALUES as readonly string[]).includes(name)) return ANY;
  for (const s of d.steps) {
    if (s.kind === "loop" && s.item === name) {
      const over = shapeOf(d, s.over);
      return over.t === "list" ? over.of : ANY;
    }
    if (s.kind === "loop" && s.outputs.includes(name)) {
      const g = s.gather.find((x) => x.into === name);
      return g ? { t: "list", of: shapeOf(d, g.from) } : ANY;
    }
    if (s.outputs.includes(name) && s.shapes?.[name]) return parseShape(s.shapes[name]);
  }
  return ANY;
}

// Fields a step's words read off an input: "submission.answers",
// "input.result.score". Only the first field after the value's name.
function fieldsRead(step: AgentStep, input: string): string[] {
  const words = step.kind === "code" ? step.description : step.kind === "decision" ? step.prompt : "";
  const re = new RegExp(`\\b(?:input\\.)?${input}\\.([A-Za-z_][A-Za-z0-9_]*)\\b`, "g");
  return [...new Set([...words.matchAll(re)].map((m) => m[1]!))].filter((f) => !["length", "map", "filter", "forEach", "slice", "join", "find", "some", "every", "reduce", "trim", "toLowerCase"].includes(f));
}

// Where the declared shapes don't meet: each reason names the step that
// reads, for the planner (planRules.ts) and the fixer.
export function shapeProblems(d: AgentDefinition): string[] {
  const out: string[] = [];
  for (const s of d.steps) {
    if (s.kind === "action") {
      const tool = d.actions.find((a) => a.id === s.action)?.tool;
      const first = s.inputs[0];
      const want = tool ? TOOL_SHAPES[tool] : undefined;
      if (!want || !first || !tool || (!ARGS_TOOLS.includes(tool) && tool !== "telegram.send" && tool !== "telegram.ask")) continue;
      const got = shapeOf(d, first);
      if (got.t === "any") continue;
      if (got.t === "text" && (tool === "telegram.send" || tool === "telegram.ask")) continue;
      const why = shapeGap(got, want);
      const maker = d.steps.find((x) => x.outputs.includes(first));
      if (why) out.push(`step "${s.id}" takes ${tool} with "${first}"${maker ? ` (made by step "${maker.id}")` : ""}, whose shape is ${showShape(got)}, but ${tool} needs ${showShape(want)}: ${why}`);
    }
    if (s.kind === "loop") {
      const got = shapeOf(d, s.over);
      if (got.t !== "any" && got.t !== "list") out.push(`loop "${s.id}" goes through "${s.over}", whose shape is ${showShape(got)}, not a list`);
    }
    if (s.kind === "decision" && s.each) {
      const got = shapeOf(d, s.each);
      if (got.t !== "any" && got.t !== "list") out.push(`decision "${s.id}" judges each item of "${s.each}", whose shape is ${showShape(got)}, not a list`);
    }
    if (s.kind === "code" || s.kind === "decision") {
      for (const input of s.inputs) {
        const got = shapeOf(d, input);
        if (got.t !== "object" || got.open) continue;
        const missing = fieldsRead(s, input).filter((f) => !(f in got.fields));
        const maker = d.steps.find((x) => x.outputs.includes(input) || (x.kind === "loop" && x.item === input));
        if (missing.length) out.push(`step "${s.id}" reads ${missing.map((f) => `${input}.${f}`).join(", ")}, but "${input}"${maker ? ` (from step "${maker.id}")` : ""} has the shape ${showShape(got)}: read only the fields it has, or make the step before it return them`);
      }
    }
  }
  return out;
}

// Why one declared shape can't be what another needs.
function shapeGap(got: Shape, want: Shape): string | null {
  if (want.t === "any" || got.t === "any") return null;
  if (want.t === "object") {
    if (got.t !== "object") return `it is ${showShape(got)}`;
    if (got.open) return null;
    const missing = Object.keys(want.fields).filter((k) => !(k in got.fields));
    return missing.length ? `it has no ${missing.join(", ")}` : null;
  }
  if (want.t === "list") return got.t === "list" ? null : `it is ${showShape(got)}`;
  return null;
}

// What a run made that doesn't have its declared shape: the first step
// whose output doesn't fit, and why.
export function runMisfits(d: AgentDefinition, events: RunEvent[]): { step: string; text: string } | null {
  for (const e of events) {
    if (e.type !== "step_done" || e.status !== "ok" || !e.output || typeof e.output !== "object") continue;
    const step = d.steps.find((s) => s.id === e.stepId);
    if (!step || step.kind !== "code" || !step.shapes) continue;
    for (const [name, text] of Object.entries(step.shapes)) {
      const why = misfit((e.output as Record<string, unknown>)[name], parseShape(text), name);
      if (why) return { step: step.id, text: `"${step.title}" made ${name} in a different shape from the one its plan says (${text}): ${why}, so the step after it can't read it.` };
    }
  }
  return null;
}
