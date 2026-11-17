// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "@/lib/db/schema";
import { testDb } from "@/test/helperDb";
import { learn, learnFromLive, lessonKey, lessonsByCount, recipeRules, recurringRules } from "./lessons";
import { emptyHeal, type Diagnosis, type HealLog } from "./types";
import { rulesText } from "./lessonRules";

// What healing builds learned: each repair that fixed a build, counted,
// and a mistake that keeps coming back in more than one maker's builds
// becomes a rule for the planner and Dolphin.

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: (_, key) => Reflect.get(state.db as object, key) }) }));

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
beforeAll(async () => {
  ({ client, db } = await testDb());
  state.db = db;
});
afterAll(async () => client.close());

describe("lessons", () => {
  it("count the same lesson up however it is worded next time", async () => {
    expect(lessonKey("nothing_to_do", "A step that always pays must always return the payment.")).toBe(lessonKey("nothing_to_do", "A step that always pays must ALWAYS return the payment!"));
    await learn({ kind: "nothing_to_do", rule: "A step that always pays must always return the payment.", wrong: "It checked input.skip.", fix: "Wrote its brief again.", makerId: "maker-1" });
    await learn({ kind: "nothing_to_do", rule: "A step that always pays must ALWAYS return the payment!", wrong: "It checked input.cancelled.", fix: "Wrote its brief again.", makerId: "maker-1" });
    const [l] = await lessonsByCount();
    expect(l).toMatchObject({ kind: "nothing_to_do", count: 2, makers: 1, wrong: "It checked input.cancelled." });
  });

  it("become rules only once they come back in more than one maker's builds", async () => {
    // Twice, but one maker: not yet a rule.
    expect(await recurringRules()).toEqual([]);
    await learn({ kind: "nothing_to_do", rule: "A payment step returns the payment every run.", wrong: "It returned null.", fix: "Wrote its brief again.", makerId: "maker-2" });
    // A kind of its own, once: not a rule.
    await learn({ kind: "sample_payee", rule: "The sample saves the payee by the name the plan pays.", wrong: "No payee.", fix: "A new sample.", makerId: "maker-2" });
    expect(await recurringRules()).toEqual(["A step that always pays must always return the payment."]);
    expect(rulesText(await recurringRules())).toBe("\nRules learned from earlier builds, keep to them:\n- A step that always pays must always return the payment.");
    expect(rulesText([])).toBe("");
  });

  it("are listed by how often they were learned", async () => {
    const list = await lessonsByCount();
    expect(list.map((l) => [l.kind, l.count])).toEqual([
      ["nothing_to_do", 2],
      ["sample_payee", 1],
      ["nothing_to_do", 1],
    ]);
  });
});

describe("a recipe's lessons", () => {
  const dx = (plan: unknown): Diagnosis => ({ stage: "test", step: null, failure: "Its sample had no commits.", expected: "", evidence: { plan, spec: null, code: null, review: null, check: "did_job", trace: [], sample: null, errors: [] }, at: "2026-11-16T00:00:00.000Z" });
  const round = (plan: unknown, outcome: "fixed" | "failed", text: string) => ({ diagnosis: dx(plan), verdict: "test" as const, why: "The sample was empty.", repair: "A new sample with three commits.", outcome, lesson: { kind: "sample_empty", text }, at: "" });
  const watch = { name: "Code checker", recipe: { id: "watch", variant: "commits" } };

  it("are kept from the fixes that got a build from it live, and only those", async () => {
    const log: HealLog = {
      ...emptyHeal(),
      rounds: [
        round(watch, "fixed", "A repository's sample has commits from the last day."),
        // Not what got it live.
        round(watch, "failed", "Something that didn't work."),
        // A plan from scratch: no recipe's lesson.
        round({ name: "Other" }, "fixed", "A plan's own lesson."),
      ],
    };
    await learnFromLive(log, "maker-3");
    expect(await recipeRules("watch")).toEqual(["A repository's sample has commits from the last day."]);
    expect(await recipeRules("alert")).toEqual([]);
    expect(await recipeRules(null)).toEqual([]);
  });

  it("are given with their recipe for a plan not yet made, and never counted among the rules for every plan", async () => {
    await learn({ kind: "sample_empty", rule: "A repository's sample has commits from the last day.", wrong: "w", fix: "f", makerId: "maker-4", recipe: "watch", live: true });
    await learn({ kind: "alert_side", rule: "A price alert names the price it went past.", wrong: "w", fix: "f", makerId: "maker-4", recipe: "alert", live: true });
    expect((await recipeRules("all")).sort()).toEqual(["For the alert recipe: A price alert names the price it went past.", "For the watch recipe: A repository's sample has commits from the last day."]);
    // Two makers, twice: still a recipe's own lesson only.
    expect(await recurringRules()).not.toContain("A repository's sample has commits from the last day.");
    const kept = (await lessonsByCount()).find((l) => l.rule === "A repository's sample has commits from the last day.");
    expect(kept).toMatchObject({ count: 2, makers: 2 });
  });

  it("aren't given until a build went live with them", async () => {
    await learn({ kind: "other", rule: "Learned while fixing, not yet live.", wrong: "w", fix: "f", makerId: "maker-5", recipe: "summary" });
    expect(await recipeRules("summary")).toEqual([]);
  });
});
