// @vitest-environment node
import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { SERV_BASE_URL, SERV_MODEL, sanitizeJsonSchema } from "@/lib/model";
import { DETAIL_SCHEMA, OUTLINE_SCHEMA } from "@/lib/agents/planStages";

// How much room the planner's schemas leave under SERV's limit on a strict
// json_schema ("The compiled grammar is too large"), measured live. Each
// probe sends one schema, optionally with extra string fields on its step
// (the part a plan repeats, where one more field broke the old single
// schema), asks for an empty answer, and notes whether SERV took it. Off
// unless RUN_SCHEMA_PROBE=1 with SERV_API_KEY in the environment.
//
//   RUN_SCHEMA_PROBE=1 PROBES=outline,detail,outline+12 PROBE_REPORT=probe.json npx vitest run src/test/plan-schema-live.test.ts
//
// The old single schema, for comparison, was one field over: it is
// rebuilt here from the outline and the details joined as one answer.

const enabled = process.env.RUN_SCHEMA_PROBE === "1" && Boolean(process.env.SERV_API_KEY);

type Schema = { name: string; schema: Record<string, unknown> };
type Node = { type?: string; properties?: Record<string, Node>; items?: Node; required?: string[] };

// The schema with `extra` more string fields on each step.
function padded(s: Schema, extra: number): Schema {
  const copy = JSON.parse(JSON.stringify(s)) as Schema;
  const step = ((copy.schema as Node).properties!.steps as Node).items!;
  for (let i = 0; i < extra; i++) {
    step.properties![`extra_${i}`] = { type: "string" };
    step.required!.push(`extra_${i}`);
  }
  return copy;
}

// The outline and the details as one answer, as plans were asked for before.
function joined(): Schema {
  const o = JSON.parse(JSON.stringify(OUTLINE_SCHEMA)) as Schema;
  const step = ((o.schema as Node).properties!.steps as Node).items!;
  const detail = ((DETAIL_SCHEMA.schema as Node).properties!.steps as Node).items!;
  for (const [k, v] of Object.entries(detail.properties!)) {
    if (k in step.properties!) continue;
    step.properties![k] = v;
    step.required!.push(k);
  }
  return { name: "agent_plan", schema: o.schema };
}

const SCHEMAS: Record<string, Schema> = { outline: OUTLINE_SCHEMA, detail: DETAIL_SCHEMA, joined: joined() };

// A rough size, for the report: every property, enum value and list.
function weight(node: unknown): number {
  if (!node || typeof node !== "object") return 0;
  const n = node as Node & { enum?: unknown[] };
  return (n.properties ? Object.keys(n.properties).length : 0) + (n.enum?.length ?? 0) + (n.type === "array" ? 1 : 0) + Object.values(n.properties ?? {}).reduce((t, p) => t + weight(p), 0) + weight(n.items);
}

describe.skipIf(!enabled)("the planner's schemas, live", () => {
  it("are each taken or refused by SERV, as listed", { timeout: 600_000 }, async () => {
    const report: Record<string, unknown>[] = [];
    for (const probe of (process.env.PROBES ?? "outline,detail").split(",")) {
      const [name, extra] = probe.trim().split("+");
      const base = SCHEMAS[name!];
      if (!base) throw new Error(`no schema called ${name}`);
      const schema = padded(base, Number(extra ?? 0));
      const started = Date.now();
      const res = await fetch(`${SERV_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${process.env.SERV_API_KEY}` },
        body: JSON.stringify({
          model: SERV_MODEL,
          messages: [
            { role: "system", content: "Answer with JSON in the given schema, every string empty and every list empty." },
            { role: "user", content: "Go." },
          ],
          max_tokens: 40,
          stream: false,
          response_format: { type: "json_schema", json_schema: { name: schema.name, strict: true, schema: sanitizeJsonSchema(schema.schema) } },
        }),
      });
      const body = (await res.json().catch(() => null)) as { usage?: { prompt_tokens?: number; completion_tokens?: number }; error?: { message?: string } } | null;
      report.push({ probe, weight: weight(schema.schema), status: res.status, ms: Date.now() - started, promptTokens: body?.usage?.prompt_tokens ?? null, completionTokens: body?.usage?.completion_tokens ?? null, error: body?.error?.message ?? null });
    }
    if (process.env.PROBE_REPORT) writeFileSync(process.env.PROBE_REPORT, JSON.stringify(report, null, 2));
    expect(report.length).toBeGreaterThan(0);
  });
});
