import { z } from "zod";
import { minIntervalMinutes } from "./interval";
import { keepRequired } from "../zodErrors";

// The agent format: one versioned definition of an agent a maker builds and
// renters run. It is plain data, checked here with zod, stored in
// agent_versions.definition and shared by the server (planning, code
// writing, the test bench) and the builder.
//
// - job: what it does and what counts as done.
// - triggers: what wakes it up (a schedule, a value checked on an interval,
//   or an incoming message). A check names its own code step, which reads
//   the value and says whether the condition holds.
// - settings: what each renter answers when they set it up.
// - rules: the limits a renter may adjust (a spend cap, an approval
//   threshold, an allowed list), each with the maker's default.
// - memory: named values kept per renter between jobs.
// - steps: code (data work in the sandbox), decision (a judgement by SERV
//   with a fixed set of outcomes) or action (one declared action). A run
//   starts at the first step; each step names the next, a decision one per
//   outcome, and "null" ends the run.
// - actions: the only actions the agent may ever take, each with a tool that
//   changes something (reading happens in code steps). Every tool with a
//   side effect a code step uses must be declared here too.
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

// What a declared action may use: tools that change something. Reading and
// working things out happen in code steps.
export const ACTION_TOOLS: readonly ToolName[] = [...SIDE_EFFECT_TOOLS, "memory.set"];

// Actions whose tool needs exact arguments: the step's first input must be
// those arguments, made by a code step. A message to the owner can be made
// from anything.
export const ARGS_TOOLS: readonly ToolName[] = ["sheets.write", "wallet.pay", "memory.set"];

// Always in the bag when a run starts.
export const RUN_VALUES = ["settings", "rules", "memory", "trigger"] as const;

const key = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{0,39}$/, "use lower case letters, digits and underscores, starting with a letter");
const text = (max: number) => z.string().trim().min(1).max(max);

export const Job = z.object({ does: text(400), done: text(400) });

export const Trigger = z.discriminatedUnion("kind", [
  // every: minutes or hours, with interval (every 15 minutes, every 2
  // hours; "hour" is every 1 hour, from before intervals); day, at a time;
  // week, on days (0 is Sunday) at a time. Within the platform's minimum
  // interval (schedule.ts), whatever the plan says.
  z.object({
    kind: z.literal("schedule"),
    every: z.enum(["minutes", "hours", "hour", "day", "week"]),
    interval: z.number().int().min(1).max(1440).nullable().optional(),
    at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable(),
    days: z.array(z.number().int().min(0).max(6)).max(7).nullable().optional(),
    description: text(200),
  }),
  // step: the code step that checks, outside the run's own steps. It reads
  // the watched value and returns { holds } (and optionally { value }); the
  // run starts when holds turns true, not on every check while it stays true.
  z.object({ kind: z.literal("check"), everyMinutes: z.number().int().min(5).max(1440), watch: text(200), when: text(200), step: key.optional() }),
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

// Spending: a payment (wallet.pay), or rows written to a sheet when the
// action names amountColumn, the column holding each row's amount in USDC.
// askOver names a usdc or number rule: spending that would take the job's
// running total over its value waits for the owner's yes. askOverDay does
// the same for the installation's total for the day. Every such limit an
// agent declares applies to all of its spending, wherever it is made and
// whatever its steps decide.
export const Action = z.object({
  id: key,
  tool: z.enum(TOOL_NAMES),
  description: text(200),
  askOver: key.optional(),
  askOverDay: key.optional(),
  amountColumn: key.optional(),
});
// (Its tool must be one of ACTION_TOOLS: checked with the rest, in checkGraph.)

// plain: the step in one sentence for someone who has never seen code, as
// the agent's page shows it with details off (no names of values or tools).
const stepBase = { id: key, title: text(80), plain: z.string().trim().max(200).optional(), inputs: z.array(key).max(12), outputs: z.array(key).max(12) };

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
  // For an action that waits for the owner (a question, or a payment over a
  // rule's limit): where to go when no answer comes in time, or the owner
  // says no to the payment. Without it the job stops there.
  otherwise: key.nullable().optional(),
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
  // How long the owner has to answer before it counts as no answer.
  approvalHours: z.number().int().min(1).max(168).optional(),
});

export const DEFAULT_APPROVAL_HOURS = 24;

export type AgentDefinition = z.infer<typeof Shape>;
export type AgentStep = z.infer<typeof Step>;
export type CodeStepDef = z.infer<typeof CodeStep>;
export type DecisionStepDef = z.infer<typeof DecisionStep>;
export type ActionStepDef = z.infer<typeof ActionStep>;
export type StepKind = AgentStep["kind"];

// Whether an action spends: a payment, or rows with an amount column.
export function spends(a: { tool: ToolName; amountColumn?: string }): boolean {
  return a.tool === "wallet.pay" || (a.tool === "sheets.write" && Boolean(a.amountColumn));
}

// The connections an agent needs its owner to have: Telegram for an agent
// that messages or asks its owner or takes their messages, Google for one
// that reads or writes sheets.
export function connectionsNeeded(d: AgentDefinition): { telegram: boolean; google: boolean } {
  const tools = new Set<ToolName>([...d.actions.map((a) => a.tool), ...d.steps.flatMap((s) => (s.kind === "code" ? s.tools : []))]);
  return {
    telegram: tools.has("telegram.send") || tools.has("telegram.ask") || d.triggers.some((t) => t.kind === "message"),
    google: tools.has("sheets.read") || tools.has("sheets.write") || d.settings.some((s) => s.type === "sheet"),
  };
}

// What the guided setup needs of an agent, and no more: its name, the
// questions it asks, its rules, its schedule and the connections it needs.
// A renter's setup gets this, never the definition (its steps hold the
// code steps' descriptions and the decisions' prompts).
export type SetupShape = Pick<AgentDefinition, "name" | "settings" | "rules" | "triggers"> & { needs: { telegram: boolean; google: boolean }; spends?: boolean };

export function setupShapeOf(d: AgentDefinition): SetupShape {
  return { name: d.name, settings: d.settings, rules: d.rules, triggers: d.triggers.filter((t) => t.kind === "schedule"), needs: connectionsNeeded(d), spends: d.actions.some(spends) };
}

// Why moving an installation from one version of an agent to another
// needs setting it up again, or null when its answers carry over: a setup
// question added, removed or changed, or a connection it didn't need.
export function breakingChange(from: AgentDefinition, to: AgentDefinition): string | null {
  const before = new Map(from.settings.map((s) => [s.key, s.type]));
  const after = new Map(to.settings.map((s) => [s.key, s.type]));
  const added = to.settings.filter((s) => !before.has(s.key));
  if (added.length) return `It asks something new at setup ("${added[0]!.label}").`;
  const gone = from.settings.filter((s) => !after.has(s.key));
  if (gone.length) return `It no longer asks "${gone[0]!.label}" at setup.`;
  const changed = to.settings.find((s) => before.get(s.key) !== s.type);
  if (changed) return `"${changed.label}" takes a different kind of answer now.`;
  const was = connectionsNeeded(from);
  const now = connectionsNeeded(to);
  if (now.telegram && !was.telegram) return "It needs your Telegram now.";
  if (now.google && !was.google) return "It needs your Google Sheets now.";
  return null;
}

// Where a step can go next: one step, or one per outcome, and for an action
// that waits for the owner, where it goes without an answer.
export function nextOf(step: AgentStep): (string | null)[] {
  if (step.kind === "decision") return step.outcomes.map((o) => o.next);
  if (step.kind === "action" && step.otherwise) return [step.next, step.otherwise];
  return [step.next];
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
  d.actions.forEach((a, i) => {
    if (!ACTION_TOOLS.includes(a.tool)) say(`action "${a.id}" uses ${a.tool}, which only reads: reading happens in code steps, and actions only change things`, ["actions", i, "tool"]);
    if (a.amountColumn && a.tool !== "sheets.write") say(`action "${a.id}" names an amount column, which only rows written to a sheet (sheets.write) have`, ["actions", i, "amountColumn"]);
    for (const field of ["askOver", "askOverDay"] as const) {
      const limit = a[field];
      if (!limit) continue;
      const rule = d.rules.find((r) => r.key === limit);
      if (!spends(a)) say(`action "${a.id}" asks over a limit, which only spending can: a payment (wallet.pay), or sheets.write with an amountColumn`, ["actions", i, field]);
      else if (!rule) say(`action "${a.id}" asks over "${limit}", which is not a rule`, ["actions", i, field]);
      else if (rule.type !== "usdc" && rule.type !== "number") say(`action "${a.id}" asks over "${limit}", which must be a usdc or number rule`, ["actions", i, field]);
    }
  });
  const known = new Set(ids);
  const produced = new Set<string>([...RUN_VALUES, ...d.steps.flatMap((s) => s.outputs)]);
  const declared = new Map(d.actions.map((a) => [a.id, a]));
  const declaredTools = new Set(d.actions.map((a) => a.tool));

  // Which code step makes each value.
  const madeBy = new Map<string, AgentStep>();
  for (const s of d.steps) for (const o of s.outputs) if (!madeBy.has(o)) madeBy.set(o, s);
  const bags = [
    ["settings", d.settings.map((x) => x.key)],
    ["rules", d.rules.map((x) => x.key)],
    ["memory", d.memory.map((x) => x.key)],
  ] as const;

  d.steps.forEach((s, i) => {
    // A step whose words name a setting, rule or memory key must read it.
    const words = s.kind === "code" ? s.description : s.kind === "decision" ? s.prompt : "";
    for (const [bag, keys] of bags) {
      const named = keys.find((k) => new RegExp(`\\b${k}\\b`).test(words));
      if (named && !s.inputs.includes(bag)) say(`step "${s.id}" uses ${bag}.${named} but doesn't read ${bag}: add "${bag}" to its inputs`, ["steps", i, "inputs"]);
    }
    if (s.kind === "action") {
      const action = declared.get(s.action);
      const first = s.inputs[0];
      if (action && ARGS_TOOLS.includes(action.tool) && (!first || madeBy.get(first)?.kind !== "code")) {
        say(`step "${s.id}" takes ${s.action} (${action.tool}), so its first input must be ${action.tool}'s arguments, made by a code step before it`, ["steps", i, "inputs"]);
      } else if (action && ARGS_TOOLS.includes(action.tool) && first && d.steps.some((o) => o.id !== s.id && o.inputs.includes(first))) {
        say(`step "${s.id}" takes ${s.action} (${action.tool}) with "${first}", which other steps read too: give it a value of its own, made by a code step as ${action.tool}'s arguments`, ["steps", i, "inputs"]);
      }
    }
    nextOf(s).forEach((n) => {
      if (n !== null && !known.has(n)) say(`step "${s.id}" goes to "${n}", which is not a step`, ["steps", i]);
    });
    for (const input of s.inputs) {
      if (produced.has(input)) continue;
      const bag = bags.find(([, keys]) => (keys as readonly string[]).includes(input))?.[0];
      say(
        bag
          ? `step "${s.id}" reads "${input}", which is one of the ${bag}: list "${bag}" in its inputs and use ${bag}.${input}`
          : `step "${s.id}" reads "${input}", which no step outputs and is not one of ${RUN_VALUES.join(", ")}`,
        ["steps", i, "inputs"],
      );
    }
    if (s.kind === "decision") for (const id of duplicates(s.outcomes.map((o) => o.id))) say(`step "${s.id}" has two outcomes called "${id}"`, ["steps", i, "outcomes"]);
    if (s.kind === "action" && !declared.has(s.action)) say(`step "${s.id}" takes "${s.action}", which is not a declared action`, ["steps", i, "action"]);
    if (s.kind === "action" && s.otherwise) {
      const action = declared.get(s.action);
      if (action && action.tool !== "telegram.ask" && !action.askOver && !action.askOverDay) say(`step "${s.id}" has somewhere to go without an answer, but its action never waits for one`, ["steps", i, "otherwise"]);
    }
    if (s.kind === "code") {
      for (const tool of s.tools) {
        if (SIDE_EFFECT_TOOLS.includes(tool) && !declaredTools.has(tool)) say(`step "${s.id}" uses ${tool}, but no declared action uses it`, ["steps", i, "tools"]);
      }
    }
  });

  // Schedules and checks keep to the platform's minimum interval.
  const least = minIntervalMinutes();
  d.triggers.forEach((t, i) => {
    if (t.kind === "schedule" && t.every === "minutes" && (t.interval ?? 0) < least) say(`a schedule runs at most every ${least} minutes`, ["triggers", i, "interval"]);
    if (t.kind === "schedule" && t.every === "hours" && !t.interval) say("an hourly schedule says every how many hours", ["triggers", i, "interval"]);
    if (t.kind === "schedule" && t.every === "week" && t.days && !t.days.length) say("a weekly schedule names at least one day", ["triggers", i, "days"]);
    if (t.kind === "check" && t.everyMinutes < least) say(`a value check runs at most every ${least} minutes`, ["triggers", i, "everyMinutes"]);
  });
  // A check trigger's step reads and says whether the condition holds; it
  // isn't one of the run's steps.
  const checks = new Set<string>();
  d.triggers.forEach((t, i) => {
    if (t.kind !== "check") return;
    if (!t.step) return say("a check trigger names the code step that reads the value and returns { holds }", ["triggers", i, "step"]);
    const st = d.steps.find((x) => x.id === t.step);
    if (!st) return say(`the check trigger's step "${t.step}" is not a step`, ["triggers", i, "step"]);
    checks.add(st.id);
    if (st.kind !== "code") return say(`the check trigger's step "${st.id}" must be a code step`, ["triggers", i, "step"]);
    if (!st.outputs.includes("holds")) say(`the check step "${st.id}" must output holds (true when the condition is met)`, ["triggers", i, "step"]);
    if (st.next !== null) say(`the check step "${st.id}" only checks: its next must be empty`, ["triggers", i, "step"]);
    for (const tool of st.tools) if (SIDE_EFFECT_TOOLS.includes(tool) || tool === "memory.set") say(`the check step "${st.id}" only reads, so it can't use ${tool}`, ["triggers", i, "step"]);
    for (const input of st.inputs) if (!(RUN_VALUES as readonly string[]).includes(input) || input === "trigger") say(`the check step "${st.id}" can only read settings, rules and memory, not "${input}"`, ["triggers", i, "step"]);
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
    if (checks.has(s.id)) {
      if (seen.has(s.id)) say(`the check step "${s.id}" can't also be a step of the run`, ["steps", i]);
    } else if (!seen.has(s.id)) say(`step "${s.id}" can't be reached from the first step`, ["steps", i]);
  });

  // Every way into a step must have made what it reads: a value made only on
  // one branch of a decision can't be read where the branches meet.
  const all = new Set<string>([...RUN_VALUES, ...d.steps.flatMap((s) => s.outputs)]);
  const into = new Map<string, Set<string>>(d.steps.map((s, i) => [s.id, new Set(i === 0 ? RUN_VALUES : all)]));
  const preds = new Map<string, AgentStep[]>(d.steps.map((s) => [s.id, []]));
  for (const s of d.steps) for (const n of nextOf(s)) if (n && preds.has(n)) preds.get(n)!.push(s);
  for (let changed = true, rounds = 0; changed && rounds < 100; rounds++) {
    changed = false;
    d.steps.forEach((s, i) => {
      if (i === 0 || !seen.has(s.id)) return;
      const from = preds.get(s.id)!.filter((p) => seen.has(p.id));
      const next = new Set([...all].filter((v) => from.every((p) => into.get(p.id)!.has(v) || p.outputs.includes(v))));
      if (next.size !== into.get(s.id)!.size) {
        into.set(s.id, next);
        changed = true;
      }
    });
  }
  d.steps.forEach((s, i) => {
    if (!seen.has(s.id)) return;
    for (const input of s.inputs) {
      if (produced.has(input) && !into.get(s.id)!.has(input)) {
        say(`step "${s.id}" reads "${input}", but not every way to it makes "${input}" first`, ["steps", i, "inputs"]);
      }
    }
  });
}

export const AgentDefinitionSchema = Shape.superRefine(checkGraph);

export type DefinitionCheck = { ok: true; definition: AgentDefinition } | { ok: false; errors: string[] };

// A definition, or every reason it isn't one, in plain sentences that can go
// back to the model that wrote it.
export function checkDefinition(input: unknown): DefinitionCheck {
  const parsed = AgentDefinitionSchema.safeParse(input, { error: keepRequired });
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
