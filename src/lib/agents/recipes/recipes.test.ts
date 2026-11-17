import { describe, expect, it } from "vitest";
import { checkDefinition, type AgentDefinition, type CodeStepDef } from "../definition";
import { planProblems } from "../planRules";
import { checkCode } from "../code";
import { plainFindings } from "../vetting";
import { selfTest } from "../test";
import { fromRecipe, keptRecipe, matchesRecipe, readPick, recipeById, recipeSample, RECIPES, RECIPE_SCHEMA, recipePrompt, type Recipe, type RecipeFill } from "./index";

// Every recipe, in every variant, is a plan that checks out, code that
// passes the platform's own checks, and a build that passes its self test
// on the recipe's sample, with no model asked: what a maker's build from it
// goes through.

const DAILY = { kind: "schedule" as const, every: "day" as const, at: "09:00", description: "Every day at 9" };
const GIVEN: Record<string, Record<string, string>> = {
  watch: { github_repo: "iam25th1/boardofserv" },
  alert: { coin: "ETH", target: "$2,000", direction: "below" },
  scorer: { criteria: "A working demo and a clear README.", sheet: "Submissions", form: "https://form.typeform.com/to/AbCd1234" },
  summary: { sheet: "Sales" },
  payment: { payee: "Designer", amount: "0.5" },
  webhook: {},
};

const fillFor = (r: Recipe, variant: string): RecipeFill => ({ name: `${r.id} agent`, does: `Does the ${r.id} job.`, done: "One run done.", trigger: r.id === "webhook" ? { kind: "webhook", description: "When another app posts to it" } : DAILY, variant, task: r.task.byDefault(variant), given: GIVEN[r.id] ?? {} });

const cases = RECIPES.flatMap((r) => (r.variants.length ? r.variants.map((v) => [r, v.id] as const) : [[r, ""] as const]));

describe.each(cases)("the %s recipe (%s)", (recipe, variant) => {
  const built = fromRecipe(recipe, fillFor(recipe, variant))!;
  const d = built?.definition;

  it("is a plan that checks out, with nothing the step rules would change", () => {
    expect(built).not.toBeNull();
    expect(checkDefinition(d)).toMatchObject({ ok: true });
    expect(planProblems(d)).toEqual([]);
    expect(d.recipe).toMatchObject({ id: recipe.id, variant, rev: recipe.rev });
  });

  it("has code for each code step that passes the plain checks, approved as the recipe's", () => {
    const sources = Object.values(built.code).map((c) => c.source ?? "");
    for (const s of d.steps.filter((x): x is CodeStepDef => x.kind === "code")) {
      const c = built.code[s.id]!;
      expect(c).toMatchObject({ status: "approved", writer: "recipe" });
      expect(checkCode(c.source!, s, d), s.id).toBeNull();
      expect(plainFindings(s, c.source!, { memory: d.memory, sources }).filter((f) => f.severity === "blocking"), s.id).toEqual([]);
    }
    expect(matchesRecipe(d, built.code)).toBe(true);
  });

  it("passes its self test on its own sample, with no model asked", async () => {
    const sample = recipeSample(d, built.code);
    expect(sample).not.toBeNull();
    const t = await selfTest({ definition: d, code: built.code }, { serv: null, sample });
    expect(t.result.problems).toEqual([]);
    expect(t.result.status).toBe("passed");
  });
});

describe("what each recipe sends", () => {
  const run = async (id: string, variant = "") => {
    const recipe = recipeById(id)!;
    const built = fromRecipe(recipe, fillFor(recipe, variant))!;
    const t = await selfTest({ definition: built.definition, code: built.code }, { serv: null, sample: recipeSample(built.definition, built.code) });
    const sent = t.events.filter((e) => e.type === "tool" && e.tool === "telegram.send").map((e) => String(((e as { args: { text?: unknown } }).args ?? {}).text ?? ""));
    return { t, sent, built };
  };

  it("watch: one message naming every commit judged, each read with its changes and judged once", async () => {
    const { t, sent } = await run("watch", "commits");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/3 commits checked/);
    const tools = t.events.filter((e) => e.type === "tool").map((e) => (e as { tool: string }).tool);
    expect(tools.filter((x) => x === "serv.reason")).toHaveLength(3);
    expect(tools.filter((x) => x === "github.read")).toHaveLength(4);
  });

  it("alert: the price below the target, once, with no model call", async () => {
    const { t, sent } = await run("alert");
    expect(sent).toEqual([expect.stringMatching(/^Ethereum is at \$1840.*below your target of \$2000\.$/)]);
    expect(t.events.some((e) => e.type === "tool" && (e as { tool: string }).tool === "serv.reason")).toBe(false);
  });

  it("scorer: a sheet's rows scored and written back, a form's responses scored, both summed up", async () => {
    const sheet = await run("scorer", "sheet");
    expect(sheet.sent[0]).toMatch(/^3 rows scored:/);
    expect(sheet.t.events.some((e) => e.type === "tool" && (e as { tool: string }).tool === "sheets.update")).toBe(true);
    const form = await run("scorer", "form");
    expect(form.sent[0]).toMatch(/^3 responses scored:/);
  });

  it("summary: this week's rows counted and their amounts totalled", async () => {
    const { sent } = await run("summary", "week");
    expect(sent).toEqual(["2 rows this week: Amount 33.5."]);
    const day = await run("summary", "day");
    expect(day.sent).toEqual(["2 rows today: Amount 33.5."]);
  });

  it("payment: pays after the owner's yes, then a receipt", async () => {
    const { t, sent } = await run("payment");
    expect(t.events.some((e) => e.type === "tool" && (e as { tool: string }).tool === "wallet.pay" && !(e as { error?: unknown }).error)).toBe(true);
    expect(sent[0]).toMatch(/^Paid 0\.5 USDC to Designer/);
  });

  it("webhook: SERV's message about what was posted", async () => {
    const { sent } = await run("webhook");
    expect(sent[0]).toMatch(/order\.paid/);
  });
});

describe("picking a recipe", () => {
  const trigger = (w: Record<string, unknown>) => (w.every === "day" ? DAILY : null);
  const said = "i would like a mini agent that checks githubs and verifies code, work, quality. iam25th1/boardofserv every day at 9";

  it("lists every recipe for SERV, with its variants and setup", () => {
    const prompt = recipePrompt();
    for (const r of RECIPES) expect(prompt).toContain(`- ${r.id}: `);
    expect(JSON.stringify(RECIPE_SCHEMA.schema)).toContain('"none"');
  });

  it("keeps only the answers the maker gave, and falls back to the default task", () => {
    const pick = readPick({ recipe: "watch", variant: "commits", name: "Code checker", does: "Checks each new commit's quality.", done: "Each new commit judged.", task: "", given: [{ key: "github_repo", value: "iam25th1/boardofserv" }, { key: "criteria", value: "tests" }], trigger: { kind: "schedule", every: "day", interval: 0, at: "09:00", days: "", description: "Every day at 9" } }, { said, trigger })!;
    expect(pick.recipe.id).toBe("watch");
    expect(pick.fill.given).toEqual({ github_repo: "iam25th1/boardofserv" });
    expect(pick.fill.task).toMatch(/^Good work in this commit is correct, clear and safe/);
    // A repository the maker never named is no answer of theirs.
    const made = readPick({ recipe: "watch", variant: "commits", name: "Checker", does: "Checks.", done: "Done.", task: "", given: [{ key: "github_repo", value: "octocat/Hello-World" }], trigger: { kind: "schedule", every: "day", at: "09:00" } }, { said, trigger })!;
    expect(made.fill.given).toEqual({});
  });

  it("plans from scratch for none, a recipe it was told to avoid, another service, or paying nobody asked for", () => {
    const base = { variant: "", name: "X", does: "Does it.", done: "Done.", task: "", given: [], trigger: { kind: "schedule", every: "day", at: "09:00" } };
    expect(readPick({ ...base, recipe: "none" }, { said, trigger })).toBeNull();
    expect(readPick({ ...base, recipe: "watch" }, { said, trigger, avoid: "watch" })).toBeNull();
    expect(readPick({ ...base, recipe: "watch" }, { said, trigger, services: ["github", "slack"] })).toBeNull();
    expect(readPick({ ...base, recipe: "payment" }, { said: "send me a weekly report", trigger })).toBeNull();
    expect(readPick({ ...base, recipe: "payment" }, { said: "every friday pay my designer 0.5 USDC", trigger })?.recipe.id).toBe("payment");
  });
});

describe("a recipe changed", () => {
  const recipe = recipeById("watch")!;
  const built = fromRecipe(recipe, fillFor(recipe, "commits"))!;

  it("stays the recipe with a new schedule, and isn't once its steps change", () => {
    const hourly: AgentDefinition = { ...built.definition, triggers: [{ kind: "schedule", every: "hours", interval: 1, at: null, description: "Every hour" }] };
    expect(matchesRecipe(hourly, built.code)).toBe(true);
    const { recipe: _r, ...untagged } = hourly;
    expect(keptRecipe(built.definition, untagged as AgentDefinition).recipe).toEqual(built.definition.recipe);
    const changed = { ...untagged, steps: untagged.steps.map((s) => (s.id === "write_message" && s.kind === "code" ? { ...s, description: `${s.description} Also list the authors.` } : s)) } as AgentDefinition;
    expect(keptRecipe(built.definition, changed).recipe).toBeUndefined();
    expect(matchesRecipe({ ...changed, recipe: built.definition.recipe }, built.code)).toBe(false);
  });

  it("is still the recipe read back from the database, whatever order its keys come back in", () => {
    // jsonb keeps no key order: shorter keys first, then by bytes.
    const jsonb = (x: unknown): unknown =>
      Array.isArray(x) ? x.map(jsonb) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.length - b.length || (a < b ? -1 : 1)).map(([k, v]) => [k, jsonb(v)])) : x;
    for (const r of RECIPES) {
      for (const variant of r.variants.length ? r.variants.map((v) => v.id) : [""]) {
        const b = fromRecipe(r, fillFor(r, variant))!;
        expect(matchesRecipe(jsonb(b.definition) as AgentDefinition, jsonb(b.code) as typeof b.code), `${r.id} ${variant}`).toBe(true);
      }
    }
  });

  it("isn't the recipe once a step's code was written by anyone else", () => {
    const code = { ...built.code, judge_items: { ...built.code.judge_items!, writer: "dolphin" as const } };
    expect(matchesRecipe(built.definition, code)).toBe(false);
  });
});
