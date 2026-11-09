import { z } from "zod";

// The agent format: one versioned definition of an agent a maker builds and
// renters run. It is plain data, checked here with zod, stored in
// agent_versions.definition and shared by the server (planning, code
// writing, the test bench) and the builder.
//
// - job: what it does and what counts as done.
// - triggers: what wakes it up (a schedule, a value checked on an interval,
//   or an incoming message). Stored now; they start runs in a later phase.
// - settings: what each renter answers when they set it up.
// - rules: the limits a renter may adjust (a spend cap, an approval
//   threshold, an allowed list), each with the maker's default.
// - memory: named values kept per renter between jobs.
// - steps: code (data work in the sandbox), decision (a judgement by SERV
//   with a fixed set of outcomes) or action (one declared action). A run
//   starts at the first step; each step names the next, a decision one per
//   outcome, and "null" ends the run.
// - actions: the only actions the agent may ever take. Every tool with a
//   side effect a step uses must be declared here.
// - limits: the most steps, seconds and model spend one job may use.
//
// Steps pass values through one bag per run: settings, rules, memory and
// trigger are there from the start, and each step adds its outputs. A step's
// inputs name what it reads from the bag.

export const AGENT_FORMAT = 1;

export const TOOL_NAMES = [
  "sheets.read",
  "sheets.write",
  "web.fetch",
  "web.search",
  "telegram.send",
  "telegram.ask",
  "memory.get",
  "memory.set",
  "wallet.pay",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

// Tools that change something outside the run: a step may use one only when
// the agent declares an action with it.
export const SIDE_EFFECT_TOOLS: readonly ToolName[] = ["sheets.write", "telegram.send", "telegram.ask", "wallet.pay"];

// Always in the bag when a run starts.
export const RUN_VALUES = ["settings", "rules", "memory", "trigger"] as const;

const key = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{0,39}$/, "use lower case letters, digits and underscores, starting with a letter");
const text = (max: number) => z.string().trim().min(1).max(max);

export const Job = z.object({ does: text(400), done: text(400) });

export const Trigger = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("schedule"), every: z.enum(["hour", "day", "week"]), at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable(), description: text(200) }),
  z.object({ kind: z.literal("check"), everyMinutes: z.number().int().min(5).max(1440), watch: text(200), when: text(200) }),
  z.object({ kind: z.literal("message"), from: z.enum(["telegram"]), description: text(200) }),
]);

export const SETTING_TYPES = ["text", "number", "boolean", "choice", "list", "sheet", "url"] as const;
export const Setting = z.object({
  key,
  label: text(80),
  type: z.enum(SETTING_TYPES),
  help: text(200),
  // The answers to pick from, for a choice; empty otherwise.
  choices: z.array(text(40)).max(12),
});

export const RULE_TYPES = ["number", "usdc", "boolean", "list", "text"] as const;
export const Rule = z.object({
  key,
  label: text(80),
  type: z.enum(RULE_TYPES),
  // The maker's default, as text: "250", "true", "Linen, Cotton".
  value: z.string().trim().max(200),
  help: text(200),
});

export const Memory = z.object({ key, description: text(200), type: z.enum(["text", "number", "list", "record"]) });

export const Action = z.object({ id: key, tool: z.enum(TOOL_NAMES), description: text(200) });

const stepBase = { id: key, title: text(80), inputs: z.array(key).max(12), outputs: z.array(key).max(12) };

export const CodeStep = z.object({
  ...stepBase,
  kind: z.literal("code"),
  // What the code must do, in plain words: the brief Dolphin writes from.
  description: text(800),
  tools: z.array(z.enum(TOOL_NAMES)).max(9),
  next: key.nullable(),
});

export const Outcome = z.object({ id: key, label: text(80), next: key.nullable() });

export const DecisionStep = z.object({
  ...stepBase,
  kind: z.literal("decision"),
  // What SERV is asked, with the step's inputs beside it.
  prompt: text(800),
  outcomes: z.array(Outcome).min(2).max(6),
});

export const ActionStep = z.object({
  ...stepBase,
  kind: z.literal("action"),
  // One of the agent's declared actions, taken with the step's inputs.
  action: key,
  next: key.nullable(),
});

export const Step = z.discriminatedUnion("kind", [CodeStep, DecisionStep, ActionStep]);

export const Limits = z.object({
  maxSteps: z.number().int().min(1).max(200),
  maxRunSeconds: z.number().int().min(5).max(900),
  maxSpendUsd: z.number().min(0).max(5),
});

const Shape = z.object({
  format: z.literal(AGENT_FORMAT),
  name: text(60),
  job: Job,
  triggers: z.array(Trigger).min(1).max(4),
  settings: z.array(Setting).max(12),
  rules: z.array(Rule).max(12),
  memory: z.array(Memory).max(12),
  steps: z.array(Step).min(1).max(30),
  actions: z.array(Action).max(12),
  limits: Limits,
});

export type AgentDefinition = z.infer<typeof Shape>;
export type AgentStep = z.infer<typeof Step>;
export type CodeStepDef = z.infer<typeof CodeStep>;
export type DecisionStepDef = z.infer<typeof DecisionStep>;
export type ActionStepDef = z.infer<typeof ActionStep>;
export type StepKind = AgentStep["kind"];

// Where a step can go next: one step, or one per outcome.
export function nextOf(step: AgentStep): (string | null)[] {
  return step.kind === "decision" ? step.outcomes.map((o) => o.next) : [step.next];
}

function duplicates(values: string[]): string[] {
  return [...new Set(values.filter((v, i) => values.indexOf(v) !== i))];
}

// What the shape alone can't say: names are unique, every step it points to
// exists and can be reached from the first, inputs come from somewhere,
// action steps take a declared action, and every side effect is declared.
function checkGraph(d: AgentDefinition, ctx: z.RefinementCtx) {
  const say = (message: string, path: (string | number)[]) => ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
  const ids = d.steps.map((s) => s.id);
  for (const id of duplicates(ids)) say(`two steps are called "${id}"`, ["steps"]);
  for (const [list, name] of [
    [d.settings, "settings"],
    [d.rules, "rules"],
    [d.memory, "memory"],
    [d.actions, "actions"],
  ] as const) {
    for (const k of duplicates(list.map((x) => ("key" in x ? x.key : x.id)))) say(`two ${name} are called "${k}"`, [name]);
  }
  const known = new Set(ids);
  const produced = new Set<string>([...RUN_VALUES, ...d.steps.flatMap((s) => s.outputs)]);
  const declared = new Map(d.actions.map((a) => [a.id, a]));
  const declaredTools = new Set(d.actions.map((a) => a.tool));

  d.steps.forEach((s, i) => {
    nextOf(s).forEach((n) => {
      if (n !== null && !known.has(n)) say(`step "${s.id}" goes to "${n}", which is not a step`, ["steps", i]);
    });
    for (const input of s.inputs) if (!produced.has(input)) say(`step "${s.id}" reads "${input}", which no step outputs and is not one of ${RUN_VALUES.join(", ")}`, ["steps", i, "inputs"]);
    if (s.kind === "decision") for (const id of duplicates(s.outcomes.map((o) => o.id))) say(`step "${s.id}" has two outcomes called "${id}"`, ["steps", i, "outcomes"]);
    if (s.kind === "action" && !declared.has(s.action)) say(`step "${s.id}" takes "${s.action}", which is not a declared action`, ["steps", i, "action"]);
    if (s.kind === "code") {
      for (const tool of s.tools) {
        if (SIDE_EFFECT_TOOLS.includes(tool) && !declaredTools.has(tool)) say(`step "${s.id}" uses ${tool}, but no declared action uses it`, ["steps", i, "tools"]);
      }
    }
  });

  // Every step can be reached from the first.
  const seen = new Set<string>();
  const queue = d.steps.length ? [d.steps[0]!.id] : [];
  const byId = new Map(d.steps.map((s) => [s.id, s]));
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const n of nextOf(byId.get(id)!)) if (n !== null && byId.has(n)) queue.push(n);
  }
  d.steps.forEach((s, i) => {
    if (!seen.has(s.id)) say(`step "${s.id}" can't be reached from the first step`, ["steps", i]);
  });
}

export const AgentDefinitionSchema = Shape.superRefine(checkGraph);

export type DefinitionCheck = { ok: true; definition: AgentDefinition } | { ok: false; errors: string[] };

// A definition, or every reason it isn't one, in plain sentences that can go
// back to the model that wrote it.
export function checkDefinition(input: unknown): DefinitionCheck {
  const parsed = AgentDefinitionSchema.safeParse(input);
  if (parsed.success) return { ok: true, definition: parsed.data };
  const errors = parsed.error.issues.map((i) => (i.code === z.ZodIssueCode.custom ? i.message : `${i.path.join(".") || "definition"}: ${i.message}`));
  return { ok: false, errors: [...new Set(errors)].slice(0, 20) };
}

// The code steps' signature: what goes into the step and what it must give back.
export function stepContract(step: AgentStep): string {
  return `input { ${step.inputs.join(", ") || "nothing"} } -> output { ${step.outputs.join(", ") || "nothing"} }`;
}

// A short fingerprint of what a code step must do: when it is unchanged, the
// step's code can stay.
export function codeSpec(step: CodeStepDef): string {
  return JSON.stringify([step.description, step.inputs, step.outputs, [...step.tools].sort()]);
}
