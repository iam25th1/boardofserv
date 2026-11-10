// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { restockDefinition, RESTOCK_CODE, testRuntime } from "@/test/runtimeFixtures";
import { ANSWER_LIMITS, MODEL_PURPOSES } from "./modelLimits";
import { modelConfig } from "./model";
import { servOnly } from "./agents/build";
import { askGuard } from "./agents/guard";
import { askServ } from "./agents/runner";
import { reviewVersion } from "./agents/vetting";
import { reviewCode } from "./agents/code";
import { screenText } from "./agents/screen";
import { screenContent } from "./safety/moderation";
import type { CodeStepDef, DecisionStepDef } from "./agents/definition";

// Each call says what it is for and sends that purpose's answer limit, from
// the one file that sets them: SERV checks credit against the limit sent.

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
beforeAll(async () => {
  ({ client, db } = await testDb());
});
afterAll(async () => client.close());

const serv = servOnly(modelConfig({ SERV_API_KEY: "test-serv", MODEL_RETRY_BACKOFF_MS: "0" }));

// Answers anything, and keeps what was sent.
function listening() {
  const sent: { schema: string; maxTokens: number }[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { max_tokens: number; response_format?: { json_schema?: { name?: string } } };
    sent.push({ schema: body.response_format?.json_schema?.name ?? "", maxTokens: body.max_tokens });
    return Response.json({ choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
  }) as typeof fetch;
  return { sent, fetchImpl };
}

describe("answer limits", () => {
  it("are set for every purpose, in one place, each a whole number", () => {
    expect(MODEL_PURPOSES.sort()).toEqual(
      ["agent_plan", "chat", "code", "code_review", "compile", "decision", "guard", "helper_use", "key_check", "post_screen", "publish_review", "screen", "sketch"].sort(),
    );
    for (const p of MODEL_PURPOSES) expect(Number.isInteger(ANSWER_LIMITS[p]) && ANSWER_LIMITS[p] > 0, p).toBe(true);
    // The chat's and the plan call's are the defaults the environment can change.
    expect(modelConfig({})).toMatchObject({ maxTokens: ANSWER_LIMITS.chat, planMaxTokens: ANSWER_LIMITS.sketch });
  });

  it("are what each call sends", async () => {
    const d = restockDefinition();
    const decision = d.steps.find((s) => s.kind === "decision") as DecisionStepDef;
    const code = d.steps.find((s) => s.kind === "code") as CodeStepDef;
    const action = d.steps.find((s) => s.kind === "action")!;

    const guard = listening();
    await askGuard({ definition: d, step: action, tool: "sheets.write", risk: "write", args: { sheet: "Orders", rows: [] }, settings: {}, inputs: {}, untrusted: [] }, serv, { fetchImpl: guard.fetchImpl });
    const decide = listening();
    await askServ(decision, {}, serv, { fetchImpl: decide.fetchImpl });
    const review = listening();
    await reviewVersion(d, RESTOCK_CODE, serv, { now: new Date(), fetchImpl: review.fetchImpl });
    const codeReview = listening();
    await reviewCode("async function run() { return {}; }", code, serv, { fetchImpl: codeReview.fetchImpl });

    const rt = testRuntime(db);
    const owner = await addUser(db, "limits.owner", "limits_owner");
    const screens = listening();
    rt.fetchImpl = screens.fetchImpl;
    await screenText(rt, owner, "Linen, 12 metres", "from a sheet");
    await screenContent(rt, owner, "A restock helper for a fabric shop.", "a listing");

    expect([...guard.sent, ...decide.sent, ...review.sent, ...codeReview.sent, ...screens.sent]).toEqual([
      { schema: "action_guard", maxTokens: ANSWER_LIMITS.guard },
      { schema: "decision", maxTokens: ANSWER_LIMITS.decision },
      { schema: "version_review", maxTokens: ANSWER_LIMITS.publish_review },
      { schema: "code_review", maxTokens: ANSWER_LIMITS.code_review },
      { schema: "input_screen", maxTokens: ANSWER_LIMITS.screen },
      { schema: "content_screen", maxTokens: ANSWER_LIMITS.post_screen },
    ]);
  });
});
