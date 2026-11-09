// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { installed, publishedAgent, restockDefinition, testRuntime, type TestRuntime } from "@/test/runtimeFixtures";
import { actionArgs } from "../runner";
import { JobTools } from "./tools";

// What an agent says to its owner reads like the rest of the site: a lone
// piece of text goes as it is, and no em dash reaches them.

const EM = String.fromCharCode(0x2014);
let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let rt: TestRuntime;

beforeAll(async () => {
  ({ client, db } = await testDb());
  rt = testRuntime(db);
});
afterAll(async () => client.close());

describe("words to the owner", () => {
  it("send a lone piece of text as it is, and label anything else", () => {
    const step = { id: "tell", kind: "action", title: "Tell the owner", inputs: ["summary_text"], outputs: [], action: "a", next: null } as never;
    expect(actionArgs(step, "telegram.send", { summary_text: "Rows: 4" })).toEqual({ ok: true, args: { text: "Rows: 4" } });
    expect(actionArgs(step, "telegram.send", { rows: 4, total: 9 })).toEqual({ ok: true, args: { text: "rows: 4\ntotal: 9" } });
  });

  it("carry no em dashes, in a message or a question", async () => {
    const owner = await addUser(db, "words.owner");
    const inst = await installed(rt, owner, await publishedAgent(db, owner));
    const d = restockDefinition();
    const tools = new JobTools(rt, inst, d, null as never);
    const step = d.steps.find((s) => s.kind === "action")!;
    await tools.call(step, "telegram.send", { text: `First run ${EM} nothing to compare.` });
    const [said] = await db.select().from(schema.agentMessages).where(eq(schema.agentMessages.installationId, inst.id));
    expect(said!.text).toBe("First run, nothing to compare.");
    const asked = await tools.call(step, "telegram.ask", { question: `Send it ${EM} now?` }).catch((e: { ask?: { question: string } }) => e.ask?.question);
    expect(asked).toBe("Send it, now?");
  });
});
