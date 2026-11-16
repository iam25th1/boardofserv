import type { AgentDefinition } from "../definition";
import type { BenchData, TestResult } from "../types";

// A recipe: a tested plan for a common job, with its steps, inputs,
// outputs, tools and code fixed. SERV only picks the recipe and fills in
// what is the maker's own: the agent's name and job in their words, when it
// runs, the setup answers they gave, and what SERV is asked to judge or
// write at run time. Building from one needs no plan, no code written and
// no sample made up, so it goes the same way every time.

// What SERV fills in.
export interface RecipeFill {
  name: string;
  does: string;
  done: string;
  trigger: AgentDefinition["triggers"][number];
  // The recipe's variant (commits or pull requests, a form or a sheet), or
  // its first when it has none to pick.
  variant: string;
  // What SERV is asked at run time, in the maker's terms, for each item.
  task: string;
  // The setup answers the maker gave while describing it, by setting key.
  given: Record<string, string>;
}

// A sample to try a recipe's build on: the bench, and what the items are.
export interface RecipeSample {
  bench: BenchData;
  items: NonNullable<TestResult["items"]>;
}

export interface Recipe {
  id: string;
  // Which jobs it does, for SERV to pick by.
  fits: string;
  // Its setup questions, by key, in a few words each.
  asks: Record<string, string>;
  // The setup answers SERV may read from what the maker meant (below or
  // above), not only from their words: the rest are kept only when the
  // maker said them.
  inferred?: string[];
  // The services it uses (catalog ids), Telegram aside: a job that needs
  // another is planned from scratch.
  uses: string[];
  // Words the maker must have used for it to fit at all (paying someone).
  said?: RegExp;
  // Its variants, the first the default, each in a few words.
  variants: { id: string; says: string }[];
  // What its run-time task is, and its default.
  task: { says: string; byDefault: (variant: string) => string };
  // The plan (before checking) and each code step's source, by step id.
  build(f: RecipeFill): { definition: Record<string, unknown>; code: Record<string, string> };
  // A sample to try it on, from its own settings.
  sample(d: AgentDefinition): RecipeSample;
}

// A value of the maker's, written into a recipe's code as a JSON string:
// what SERV is asked, never code.
export const literal = (text: string) => JSON.stringify(text);

// The repository a setting names: owner/name, from a link or as given.
export const REPO_FROM_SETTING = `String((input.settings || {}).github_repo || "").trim().replace(/^https?:\\/\\/(?:www\\.)?github\\.com\\//i, "").replace(/\\.git$/i, "").replace(/\\/+$/, "").split("/").slice(0, 2).join("/")`;
