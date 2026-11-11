// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { testRuntime, type TestRuntime } from "@/test/runtimeFixtures";
import { keep } from "@/lib/connections/vault";
import { columnLetters, readTab, updateRows } from "@/lib/google/sheets";
import { MockTools, TOOL_ARGS, TOOLS } from "./toolbox";
import { ACTION_TOOLS, ARGS_TOOLS, SIDE_EFFECT_TOOLS } from "./definition";
import { describeCall } from "./calls";
import { emptyBench } from "./types";

vi.mock("server-only", () => ({}));

// Writing into a sheet's rows: sheets.update writes named columns of rows
// already there, by their numbers, at the write level, and what it writes
// stays in those rows. So an agent that marks each submission's Status
// and Reasons never sees its own results come back as new submissions.

const SUBMISSIONS = [
  { Project: "Tide Tracker", Demo: "https://tide.example", Status: null, Reasons: null },
  { Project: "Lunch Vote", Demo: "", Status: null, Reasons: null },
  { Project: "Plant Pal", Demo: "https://plant.example", Status: null, Reasons: null },
];
// What a run would take as new: rows with nothing in Status yet.
const fresh = (rows: Record<string, unknown>[]) => rows.filter((r) => !r.Status);

describe("sheets.update", () => {
  it("is a guarded tool that writes, declared as an action with its own arguments", () => {
    expect(TOOLS["sheets.update"]).toMatchObject({ sideEffect: true, risk: "write" });
    expect(SIDE_EFFECT_TOOLS).toContain("sheets.update");
    expect(ACTION_TOOLS).toContain("sheets.update");
    expect(ARGS_TOOLS).toContain("sheets.update");
    // Rows by number, never the header, and only records of cells.
    expect(TOOL_ARGS["sheets.update"].safeParse({ sheet: "Submissions", updates: [{ row: 1, values: { Status: "x" } }] }).success).toBe(false);
    expect(TOOL_ARGS["sheets.update"].safeParse({ sheet: "Submissions", updates: [] }).success).toBe(false);
    expect(TOOL_ARGS["sheets.update"].safeParse({ sheet: "Submissions", updates: [{ row: 2, values: { Status: { nested: true } } }] }).success).toBe(false);
    // The owner is asked about it in plain words.
    expect(describeCall("sheets.update", { sheet: "Submissions", updates: [{ row: 2, values: { Status: "Passed", Reasons: "All met" } }, { row: 3, values: { Status: "Rejected" } }] })).toBe(
      'Write "Status", "Reasons" into 2 rows of "Submissions"?',
    );
  });

  it("on the bench: writes into the rows it read, and a second read finds nothing new", async () => {
    const bench = { ...emptyBench(), sheets: { Submissions: structuredClone(SUBMISSIONS) } };
    const tools = new MockTools(bench);
    const { rows } = (await tools.call("sheets.read", { sheet: "Submissions" })) as { rows: (Record<string, unknown> & { _row: number })[] };
    expect(rows.map((r) => r._row)).toEqual([2, 3, 4]);
    expect(fresh(rows)).toHaveLength(3);
    const updates = rows.map((r) => ({ row: r._row, values: { Status: r.Demo ? "Passed" : "Rejected", Reasons: r.Demo ? "Demo works" : "No demo" } }));
    expect(await tools.call("sheets.update", { sheet: "Submissions", updates })).toEqual({ updated: 3 });
    // Still three rows, each with its result, and none taken as new.
    const again = (await tools.call("sheets.read", { sheet: "Submissions" })) as { rows: Record<string, unknown>[] };
    expect(again.rows).toHaveLength(3);
    expect(again.rows.map((r) => r.Status)).toEqual(["Passed", "Rejected", "Passed"]);
    expect(fresh(again.rows)).toEqual([]);
    // A row that isn't there is refused, and a row number is never a column.
    await expect(tools.call("sheets.update", { sheet: "Submissions", updates: [{ row: 9, values: { Status: "Passed" } }] })).rejects.toThrow('"Submissions" has no row 9');
    await tools.call("sheets.write", { sheet: "Submissions", rows: again.rows, mode: "replace" });
    expect(Object.keys(tools.sheets.Submissions![0]!)).not.toContain("_row");
  });

  describe("in a real sheet", () => {
    let client: PGlite;
    let db: PgliteDatabase<typeof schema>;
    let rt: TestRuntime;
    let owner: schema.User;
    const grant = { spreadsheetId: "TestSheetUpdate0001abcdefghijklmnopqrstuv", tab: "Submissions", gid: 0, title: "Hackathon" };

    beforeAll(async () => {
      ({ client, db } = await testDb());
      owner = await addUser(db, "sheet.owner");
      rt = testRuntime(db);
      await keep(rt, owner.id, "google", "owner@example.com", { refreshToken: "refresh", accessToken: "access", expiresAt: rt.now().getTime() + 3_600_000, scope: "spreadsheets" });
      rt.net.addSheet(grant.spreadsheetId, "Hackathon", { Submissions: [{ Project: "Tide Tracker", Demo: "https://tide.example" }, { Project: "Lunch Vote", Demo: "" }, { Project: "Plant Pal", Demo: "https://plant.example" }] });
    });
    afterAll(async () => client.close());

    it("writes the named columns of each row in place, adding a column the tab lacks, and reads them back as the same rows", async () => {
      const g = grant as unknown as schema.SheetGrant;
      const rows = await readTab(rt, owner.id, g);
      expect(rows.map((r) => r._row)).toEqual([2, 3, 4]);
      expect(await updateRows(rt, owner.id, g, rows.map((r) => ({ row: r._row as number, values: { Status: r.Demo ? "Passed" : "Rejected" } })))).toBe(3);
      const after = await readTab(rt, owner.id, g);
      expect(after).toHaveLength(3);
      expect(after.map((r) => [r.Project, r.Status])).toEqual([
        ["Tide Tracker", "Passed"],
        ["Lunch Vote", "Rejected"],
        ["Plant Pal", "Passed"],
      ]);
      expect(fresh(after)).toEqual([]);
      // Never past the last row with anything in it, and never the header.
      await expect(updateRows(rt, owner.id, g, [{ row: 5, values: { Status: "Passed" } }])).rejects.toThrow("has no row 5");
      expect(columnLetters(0)).toBe("A");
      expect(columnLetters(26)).toBe("AA");
    });
  });
});
