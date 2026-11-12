// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "@/lib/db/schema";
import { testDb } from "@/test/helperDb";
import { learn, lessonKey, lessonsByCount, recurringRules } from "./lessons";
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
