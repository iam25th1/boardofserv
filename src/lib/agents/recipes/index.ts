import { completeJson, type JsonResult, type ModelConfig } from "../../model";
import { ANSWER_LIMITS } from "../../modelLimits";
import { rulesText } from "../lessonRules";
import { AgentDefinitionSchema, codeSpec, type AgentDefinition, type CodeStepDef } from "../definition";
import type { StepCode } from "../types";
import { alert } from "./alert";
import { payment } from "./payment";
import { scorer } from "./scorer";
import { summary } from "./summary";
import type { Recipe, RecipeFill } from "./types";
import { watch } from "./watch";
import { webhook } from "./webhook";

export type { Recipe, RecipeFill } from "./types";

// The tested recipes (types.ts): SERV picks one for a new agent and fills
// in its words, or says none fits and the agent is planned from scratch.
export const RECIPES: Recipe[] = [watch, alert, scorer, summary, payment, webhook];

export const recipeById = (id: string | null | undefined): Recipe | null => RECIPES.find((r) => r.id === id) ?? null;

const SETUP_KEYS = [...new Set(RECIPES.flatMap((r) => Object.keys(r.asks)))];
const VARIANTS = [...new Set(RECIPES.flatMap((r) => r.variants.map((v) => v.id)))];

const str = (description: string) => ({ type: "string", description });
const obj = (properties: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });

export const RECIPE_SCHEMA = {
  name: "agent_recipe",
  schema: obj({
    recipe: { type: "string", enum: [...RECIPES.map((r) => r.id), "none"] },
    variant: { type: "string", enum: [...VARIANTS, ""] },
    name: str("a short name for the agent"),
    does: str("what it does, one or two plain sentences"),
    done: str("what counts as done for one run"),
    task: str("what SERV is asked about each item, in the maker's terms, or empty"),
    given: { type: "array", items: obj({ key: { type: "string", enum: SETUP_KEYS }, value: str("exactly as the maker said it") }) },
    trigger: obj({
      kind: { type: "string", enum: ["schedule", "webhook"] },
      every: { type: "string", enum: ["minutes", "hours", "day", "week"] },
      interval: { type: "number", description: "every minutes or hours: how many, else 0" },
      at: str('a time like "08:00", or ""'),
      days: str('every week: the days, like "friday", else ""'),
      description: str("when it runs, in plain words"),
    }),
  }),
};

export function recipePrompt(): string {
  return [
    "You match an agent a maker described to one of boardofserv's tested recipes, and fill in its words. A recipe's steps and code are fixed and tested, so it goes live the same way every time.",
    'Pick a recipe only when it does the whole job the maker asked for: everything it reads, everything it does and every way it tells them is in the recipe. When the job needs anything a recipe doesn\'t do (another service, writing somewhere else, asking them first, a condition of theirs it has no setting for, more than one job), answer recipe "none" and leave the rest empty: it is planned from scratch.',
    "",
    "The recipes:",
    ...RECIPES.map((r) => {
      const variants = r.variants.length ? `Variants: ${r.variants.map((v) => `${v.id} (${v.says})`).join(", ")}.` : 'No variants: variant "".';
      const asks = Object.entries(r.asks).map(([k, v]) => `${k} (${v})`).join(", ") || "none";
      return `- ${r.id}: ${r.fits}. ${variants} Setup: ${asks}. Task: ${r.task.says}.`;
    }),
    "",
    "Fill in, from the maker's own words:",
    "- name: a short name for the agent, a few words.",
    "- does: what it does, one or two plain sentences. done: what counts as done for one run.",
    '- variant: the recipe\'s variant that fits, or "" when it has none.',
    "- task: what SERV is asked about each item at run time, in the maker's terms (what they care about), one or two sentences; empty when the recipe says to leave it empty.",
    "- given: only the setup answers the maker gave, exactly as they gave them (a repository, a coin, a target price, a form link), by the recipe's setup keys; nothing they didn't say.",
    '- trigger: when it runs, as the maker said: every N minutes (every "minutes", interval N), every N hours (every "hours", interval N), every day at a time (every "day", at "HH:MM") or every week on some days at a time (every "week", days like "friday", at "HH:MM"); interval 0, at "" and days "" where they don\'t apply. The webhook recipe runs on a webhook trigger. description says when in plain words.',
  ].join("\n");
}

// SERV's pick for the plan request (plan.ts planRequest), at its steadiest.
// lessons: what fixed earlier builds (lessons.ts), a recipe's own among
// them, for the words it fills in.
export async function askRecipe(request: string, config: ModelConfig, o: { signal: AbortSignal; fetchImpl?: typeof fetch; temperature?: number; lessons?: string[] }): Promise<{ call: JsonResult; answer: Record<string, unknown> | null }> {
  const call = await completeJson(
    [
      { role: "system", content: `${recipePrompt()}${rulesText(o.lessons)}` },
      { role: "user", content: request },
    ],
    { config, purpose: "agent_recipe", schema: RECIPE_SCHEMA, maxTokens: ANSWER_LIMITS.agent_recipe, signal: o.signal, fetchImpl: o.fetchImpl, temperature: o.temperature },
  );
  try {
    const parsed = call.content ? (JSON.parse(call.content) as unknown) : null;
    return { call, answer: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null };
  } catch {
    return { call, answer: null };
  }
}

// Text without its spaces and marks, for finding what the maker said in
// what they wrote ("2,000" in "$2,000 or less").
const bare = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "");

export interface Picked {
  recipe: Recipe;
  fill: RecipeFill;
}

// SERV's answer as a recipe to build, or null for none (or one that can't
// be used: a recipe it doesn't have, a job the maker's words don't bear
// out). Each answer it gave is kept only where the maker said it: a recipe
// never starts from a made-up repository or price.
// services: the catalog services Describe found the job needs.
export function readPick(answer: Record<string, unknown> | null, o: { said: string; trigger: (wire: Record<string, unknown>) => AgentDefinition["triggers"][number] | null; avoid?: string | null; services?: string[] }): Picked | null {
  if (!answer) return null;
  const recipe = recipeById(String(answer.recipe ?? ""));
  if (!recipe || recipe.id === o.avoid) return null;
  if (recipe.said && !recipe.said.test(o.said)) return null;
  if ((o.services ?? []).some((x) => x !== "telegram" && !recipe.uses.includes(x))) return null;
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const name = text(answer.name, 60);
  const does = text(answer.does, 400);
  const done = text(answer.done, 400);
  if (!name || !does || !done) return null;
  const variant = recipe.variants.some((v) => v.id === answer.variant) ? String(answer.variant) : (recipe.variants[0]?.id ?? "");
  const wire = (answer.trigger ?? {}) as Record<string, unknown>;
  const trigger = recipe.id === "webhook" ? { kind: "webhook" as const, description: text(wire.description, 200) || "When another app posts to it" } : wire.kind === "webhook" ? null : o.trigger(wire);
  if (!trigger) return null;
  const said = bare(o.said);
  const given: Record<string, string> = {};
  for (const g of Array.isArray(answer.given) ? answer.given : []) {
    const { key, value } = (g ?? {}) as { key?: unknown; value?: unknown };
    const v = text(value, 500);
    if (typeof key === "string" && key in recipe.asks && v && (said.includes(bare(v)) || recipe.inferred?.includes(key))) given[key] = v;
  }
  const task = text(answer.task, 600) || recipe.task.byDefault(variant);
  return { recipe, fill: { name, does, done, trigger, variant, task: recipe.task.byDefault(variant) ? task : "", given } };
}

// A recipe built: its plan, checked against the format, and each code
// step's code, approved as the recipe's own. Null when it doesn't check
// out (a recipe whose test should have caught it).
export function fromRecipe(recipe: Recipe, fill: RecipeFill): { definition: AgentDefinition; code: Record<string, StepCode> } | null {
  const built = recipe.build(fill);
  const parsed = AgentDefinitionSchema.safeParse({ ...built.definition, recipe: { id: recipe.id, variant: fill.variant } });
  if (!parsed.success) return null;
  const d = parsed.data;
  // A number the maker gave as "$2,000" is 2000.
  d.settings = d.settings.map((s) => {
    if (s.type !== "number" || s.given === undefined) return s;
    const n = Number(s.given.replace(/[$,\s]/g, ""));
    const { given: _given, ...rest } = s;
    return Number.isFinite(n) ? { ...s, given: String(n) } : rest;
  });
  const at = new Date().toISOString();
  const code: Record<string, StepCode> = {};
  for (const s of d.steps.filter((x): x is CodeStepDef => x.kind === "code")) {
    const source = built.code[s.id];
    if (!source) return null;
    code[s.id] = { spec: codeSpec(s), status: "approved", source, rounds: 0, note: null, writer: "recipe", updatedAt: at };
  }
  return { definition: d, code };
}

// JSON with every object's keys in order: a plan read back from the
// database (jsonb keeps no key order) reads the same as the one saved.
const canonical = (x: unknown): string =>
  JSON.stringify(x, (_k, v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v));

// A plan's shape, for comparing with its recipe's: its steps (without the
// plain words a test may add), actions, memory and setup questions.
function shapeOf(d: AgentDefinition): string {
  return canonical([d.steps.map(({ plain: _plain, ...s }) => s), d.actions, d.memory, d.settings.map((s) => [s.key, s.type, s.choices])]);
}

// A code step's spec (definition.ts codeSpec) the same whatever order its
// shapes' keys came back in.
const sameSpec = (a: string, b: string) => {
  try {
    return canonical(JSON.parse(a)) === canonical(JSON.parse(b));
  } catch {
    return a === b;
  }
};

// Whether a draft is still exactly its recipe: the steps, actions, memory
// and setup questions it was built with, and each code step's code the
// recipe's own for that step. A change or a repair that touched any of it
// makes it a plan like any other (its code reviewed and tested as such).
export function matchesRecipe(d: AgentDefinition | null | undefined, code: Record<string, StepCode>): boolean {
  const recipe = recipeById(d?.recipe?.id);
  if (!d || !recipe) return false;
  const built = fromRecipe(recipe, { name: d.name, does: d.job.does, done: d.job.done, trigger: d.triggers[0]!, variant: d.recipe!.variant, task: "", given: {} });
  if (!built || shapeOf(built.definition) !== shapeOf(d)) return false;
  return d.steps.every((s) => s.kind !== "code" || (code[s.id]?.writer === "recipe" && code[s.id]?.status === "approved" && sameSpec(code[s.id]!.spec, codeSpec(s))));
}

// The recipe a changed plan still is: kept when its steps are the
// recipe's (a new schedule, a new name), dropped when they aren't.
export function keptRecipe(before: AgentDefinition | null | undefined, after: AgentDefinition): AgentDefinition {
  const { recipe: _recipe, ...rest } = after;
  if (!before?.recipe) return rest;
  const recipe = recipeById(before.recipe.id);
  const built = recipe ? fromRecipe(recipe, { name: after.name, does: after.job.does, done: after.job.done, trigger: after.triggers[0]!, variant: before.recipe.variant, task: "", given: {} }) : null;
  return built && shapeOf(built.definition) === shapeOf(rest as AgentDefinition) ? { ...rest, recipe: before.recipe } : rest;
}

// A recipe's sample for its draft's test, when the draft is still the
// recipe (no sample made up by SERV).
export function recipeSample(d: AgentDefinition, code: Record<string, StepCode>) {
  return matchesRecipe(d, code) ? recipeById(d.recipe!.id)!.sample(d) : null;
}
