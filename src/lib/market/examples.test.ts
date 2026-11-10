// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { testRuntime, type TestRuntime } from "@/test/runtimeFixtures";
import restock from "@/lib/agents/examples/restock.json";
import { runAgent } from "@/lib/agents/runner";
import { checkDefinition } from "@/lib/agents/definition";
import type { RunEvent, StepCode } from "@/lib/agents/types";
import { ExampleRefused, exampleOwner, importExample, type SavedExample } from "./examples";
import { agentPage, boardAgents } from "./listings";
import { callEstimate } from "@/lib/agents/metering";

// The example agents go on the board from their saved files: published,
// owned by the admin, free to rent, and only once.

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let rt: TestRuntime;
let admin: schema.User;

const DIR = join(process.cwd(), "src/lib/agents/examples");
const saved = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => [f, JSON.parse(readFileSync(join(DIR, f), "utf8")) as SavedExample] as const);

beforeAll(async () => {
  ({ client, db } = await testDb());
  rt = testRuntime(db);
  admin = await addUser(db, "examples.admin", "boardofserv");
});
afterAll(async () => client.close());

describe("the example agents", () => {
  it("belong to the first admin account that exists", async () => {
    expect(await exampleOwner(rt, [])).toBeNull();
    expect((await exampleOwner(rt, ["did:privy:nobody", admin.privyUserId]))!.id).toBe(admin.id);
    expect((await exampleOwner(rt, [admin.id]))!.id).toBe(admin.id);
  });

  it("go on the board from every saved file, free to rent, once", async () => {
    expect(saved.map(([f]) => f)).toContain("restock.json");
    for (const [, s] of saved) expect((await importExample(rt, admin, s)).created).toBe(true);
    const board = await boardAgents(rt);
    expect(board.map((a) => a.name).sort()).toEqual(saved.map(([, s]) => (s.definition as { name: string }).name).sort());
    for (const a of board) expect(a).toMatchObject({ weeklyPrice: "0", jobFee: "0", maker: "boardofserv", version: 1 });
    // Again: nothing new.
    for (const [, s] of saved) expect((await importExample(rt, admin, s)).created).toBe(false);
    expect(await db.select().from(schema.agents).where(eq(schema.agents.ownerUserId, admin.id))).toHaveLength(saved.length);
    // Its page has no code.
    const page = (await agentPage(rt, board[0]!.id))!;
    expect(JSON.stringify(page)).not.toMatch(/async function/);
  });

  it("each run to the end, dry, on their own bench, with no em dash in what they say", async () => {
    for (const [file, s] of saved) {
      const checked = checkDefinition(s.definition);
      if (!checked.ok) throw new Error(`${file}: ${checked.errors.join(" ")}`);
      const said: string[] = [];
      const end = await runAgent({
        definition: checked.definition,
        code: s.code as unknown as Record<string, StepCode>,
        bench: s.bench!,
        dryRun: true,
        onEvent: (e: RunEvent) => {
          if (e.type === "tool" && (e.tool === "telegram.send" || e.tool === "telegram.ask")) said.push(JSON.stringify(e.args));
        },
      });
      expect(end.status, `${file}: ${end.reason}`).toBe("done");
      expect(JSON.stringify(s).includes(String.fromCharCode(0x2014)), file).toBe(false);
      for (const words of said) expect(words.includes(String.fromCharCode(0x2014)), file).toBe(false);
    }
  });

  it("can afford the decisions they make on a live run", () => {
    for (const [file, s] of saved) {
      const d = s.definition as { steps: { kind: string }[]; limits: { maxSpendUsd: number } };
      if (d.steps.some((x) => x.kind === "decision")) expect(d.limits.maxSpendUsd, file).toBeGreaterThan(0);
    }
  });

  it("the morning sheet report compares with what it saved yesterday, in the shape it saves it", async () => {
    const s = saved.find(([f]) => f === "sheet-report.json")![1];
    const checked = checkDefinition(s.definition);
    if (!checked.ok) throw new Error(checked.errors.join(" "));
    const said: string[] = [];
    const run = (memory: Record<string, unknown>) =>
      runAgent({
        definition: checked.definition,
        code: s.code as unknown as Record<string, StepCode>,
        bench: { ...s.bench!, memory },
        dryRun: true,
        onEvent: (e: RunEvent) => {
          if (e.type === "tool" && e.tool === "telegram.send") said.push((e.args as { text: string }).text);
        },
      });
    const first = await run({});
    expect(said.at(-1)).toMatch(/^First run/);
    expect(first.memory.yesterday).toMatchObject({ rows: expect.any(Number), totals: expect.any(Object) });
    // The next morning it reads back what it saved: a comparison, not a first run.
    await run(first.memory);
    expect(said.at(-1)).toMatch(/vs yesterday/);
    expect(said.at(-1)).not.toMatch(/First run/);
  });

  it("the enquiry follow-up hears your answer, and records the reply either way in the tab you chose", async () => {
    const s = saved.find(([f]) => f === "lead-followup.json")![1];
    const checked = checkDefinition(s.definition);
    if (!checked.ok) throw new Error(checked.errors.join(" "));
    const d = checked.definition;
    // Its decision on your answer reads the answer.
    expect(d.steps.find((x) => x.id === "owner_decision")!.inputs).toEqual(["owner_answer"]);
    expect(d.steps.find((x) => x.id === "ask_owner_approval")!.outputs).toEqual(["owner_answer"]);
    for (const [answer, status] of [["approved", "ready to send"], ["rejected", "skipped"]] as const) {
      const bench = { ...s.bench!, decisions: { ...s.bench!.decisions, check_for_new_enquiry: "enquiry_found", owner_decision: answer } };
      const end = await runAgent({ definition: d, code: s.code as unknown as Record<string, StepCode>, bench, dryRun: true, onEvent: () => undefined });
      expect(end.status, `${answer}: ${end.reason}`).toBe("done");
      const tab = bench.settings.replies_sheet as string;
      expect(end.sheets[tab]!.at(-1), answer).toMatchObject({ status });
    }
  });

  it("include the enquiry follow-up on its 15-minute schedule, with its model cost estimate on its listing", async () => {
    const board = await boardAgents(rt);
    const enquiry = board.find((a) => a.name === "Enquiry follow-up")!;
    const page = (await agentPage(rt, enquiry.id))!;
    expect(page.runs).toEqual(["Runs every 15 minutes"]);
    expect(BigInt(page.modelEstimate)).toBeGreaterThan(0n);
    const lead = saved.find(([f]) => f === "lead-followup.json")![1].definition as { steps: { kind: string }[] };
    const calls = lead.steps.filter((x) => x.kind === "decision").length * 2 + lead.steps.filter((x) => x.kind === "action").length;
    expect(BigInt(page.modelEstimate)).toBe(BigInt(672 * calls) * callEstimate());
  });

  it("refuse a file without approved code for every code step", async () => {
    const broken = { ...restock, code: { ...restock.code, read_stock_and_suppliers: { ...restock.code.read_stock_and_suppliers, status: "needs_attention" } } } as unknown as SavedExample;
    await expect(importExample(rt, await addUser(db, "examples.other"), broken)).rejects.toBeInstanceOf(ExampleRefused);
  });
});
