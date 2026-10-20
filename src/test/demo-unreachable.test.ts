// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NO_MODEL_ERROR, streamReply, type ReplyEvent } from "@/lib/model";
import { DEMO_TEXT } from "@/lib/demoModel";

// The demo model answers only in development with no model set up. Anywhere
// else, no model means a plain error and never a fake reply.

const NONE = { providers: [], firstTokenTimeoutMs: 1_000, historyMessages: 12, maxTokens: 50, extractMaxTokens: 50 };

async function run(): Promise<ReplyEvent[]> {
  const events: ReplyEvent[] = [];
  for await (const ev of streamReply([{ role: "user", content: "hi" }], { config: NONE, signal: new AbortController().signal })) events.push(ev);
  return events;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the demo model", () => {
  it("answers in development when no model is set up, labelled as a demo", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const events = await run();
    expect(events[0]).toEqual({ type: "start", provider: "demo", label: "Demo reply" });
    const end = events.at(-1);
    expect(end?.type === "end" && end.result.provider).toBe("demo");
  });

  it.each(["production", "test"])("never answers when NODE_ENV is %s: the thread gets a plain error", async (env) => {
    vi.stubEnv("NODE_ENV", env);
    const events = await run();
    expect(events.some((e) => e.type === "start" || e.type === "delta")).toBe(false);
    const end = events.at(-1);
    expect(end?.type === "end" && end.result.error).toBe(NO_MODEL_ERROR);
  });

  // `npm run gate` runs this again right after `next build` with CHECK_BUILD=1.
  // The production server and client output must not contain the demo text.
  it.runIf(process.env.CHECK_BUILD === "1")("is not in the production build", () => {
    const root = join(__dirname, "..", "..", ".next");
    expect(existsSync(join(root, "BUILD_ID")), "run next build first").toBe(true);
    const marker = DEMO_TEXT.slice(0, 40);
    const offenders: string[] = [];
    for (const dir of ["server", "static"]) {
      for (const d of readdirSync(join(root, dir), { recursive: true, withFileTypes: true })) {
        if (!d.isFile() || !/\.(js|mjs|cjs|json|html|rsc|body)$/.test(d.name)) continue;
        const file = join(d.parentPath ?? (d as unknown as { path: string }).path, d.name);
        if (readFileSync(file, "utf8").includes(marker)) offenders.push(file);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
