// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { installed, publishedAgent, testRuntime, type TestRuntime } from "@/test/runtimeFixtures";
import { deliverTelegram, resetTelegramHolds } from "./deliver";
import { plainText, telegramHtml } from "./format";
import { inParts } from "./api";

// What reaches Telegram: never raw markdown. The live scorer's assessment
// showed its *asterisks* as they were.

describe("a message's text", () => {
  it("goes as Telegram's HTML: marks made into tags, everything else escaped", () => {
    expect(telegramHtml("*Score:* 8/10, **strong** demo and _clear_ README. See `npm test`.")).toBe("<b>Score:</b> 8/10, <b>strong</b> demo and <i>clear</i> README. See <code>npm test</code>.");
    expect(telegramHtml("# Today\n- Tide: 8\n* Notes: 2")).toBe("<b>Today</b>\n• Tide: 8\n• Notes: 2");
    expect(telegramHtml("Fish & chips <script>alert(1)</script> [demo](https://tide.example/a?b=1&c=\"2\")")).toBe(
      'Fish &amp; chips &lt;script&gt;alert(1)&lt;/script&gt; <a href="https://tide.example/a?b=1&amp;c=&quot;2&quot;">demo</a>',
    );
    // Arithmetic, names with underscores and code keep their characters.
    expect(telegramHtml("2 * 3 * 4 = 24 for snake_case_name and `a*b*c`")).toBe("2 * 3 * 4 = 24 for snake_case_name and <code>a*b*c</code>");
  });

  it("or plain text with the marks taken out", () => {
    expect(plainText("*Score:* 8/10, **strong** and _clear_. [demo](https://x.example)")).toBe("Score: 8/10, strong and clear. demo (https://x.example)");
  });

  it("too long for one message, goes in parts that end where a line does, nothing cut", () => {
    expect(inParts("Short one.")).toEqual(["Short one."]);
    const lines = Array.from({ length: 9 }, (_, i) => `- Entry ${i + 1}: ${"a fair reason ".repeat(40).trim()}.`);
    const parts = inParts(lines.join("\n"), 1500);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 1500)).toBe(true);
    expect(parts.join("\n")).toBe(lines.join("\n"));
    // A line longer than a part ends at a space.
    const long = inParts("word ".repeat(700).trim(), 1500);
    expect(long.every((p) => p.length <= 1500 && !p.startsWith(" ") && p.endsWith("word"))).toBe(true);
    expect(long.join(" ")).toBe("word ".repeat(700).trim());
  });
});

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let rt: TestRuntime;

beforeAll(async () => {
  ({ client, db } = await testDb());
  rt = testRuntime(db);
});
afterAll(async () => client.close());

describe("an agent's message on its way", () => {
  it("goes with parse_mode HTML and no raw asterisks", async () => {
    resetTelegramHolds();
    const owner = await addUser(db, "owner");
    const inst = await installed(rt, owner, await publishedAgent(db, owner));
    await db.insert(schema.agentMessages).values({ installationId: inst.id, from: "agent", text: "*Tide* scored **8/10**: it has a demo & a README.", tgState: "pending", createdAt: rt.now() });
    await deliverTelegram(rt);
    const [sent] = rt.net.telegram("sendMessage").slice(-1);
    expect(sent).toMatchObject({ parse_mode: "HTML", text: "Fabric restock: <b>Tide</b> scored <b>8/10</b>: it has a demo &amp; a README." });
    expect(String(sent!.text)).not.toContain("*");
  });

  it("goes in numbered parts, in order, when it is too long for one", async () => {
    resetTelegramHolds();
    const owner = await addUser(db, "owner3");
    const inst = await installed(rt, owner, await publishedAgent(db, owner));
    const lines = Array.from({ length: 5 }, (_, i) => `Entry ${i + 1}: ${"a fair reason ".repeat(70).trim()}.`);
    await db.insert(schema.agentMessages).values({ installationId: inst.id, from: "agent", text: lines.join("\n"), tgState: "pending", createdAt: rt.now() });
    const before = rt.net.telegram("sendMessage").length;
    await deliverTelegram(rt);
    const sent = rt.net.telegram("sendMessage").slice(before).map((m) => String(m.text));
    expect(sent.length).toBeGreaterThan(1);
    expect(sent[0]!.startsWith("Fabric restock: Entry 1")).toBe(true);
    expect(sent.map((t) => /\n\((\d+)\/(\d+)\)$/.exec(t)?.slice(1).join("/"))).toEqual(sent.map((_, i) => `${i + 1}/${sent.length}`));
    expect(sent.map((t) => t.replace(/\n\(\d+\/\d+\)$/, "")).join("\n")).toBe(`Fabric restock: ${lines.join("\n")}`);
  });

  it("after a part fails, sends only the parts still missing, never one twice", async () => {
    resetTelegramHolds();
    const owner = await addUser(db, "owner4");
    const inst = await installed(rt, owner, await publishedAgent(db, owner));
    // Four parts' worth.
    const lines = Array.from({ length: 4 }, (_, i) => `Entry ${i + 1}: ${"a fair reason ".repeat(220).trim()}.`);
    const [m] = await db.insert(schema.agentMessages).values({ installationId: inst.id, from: "agent", text: lines.join("\n"), tgState: "pending", createdAt: rt.now() }).returning();
    const tries: string[] = [];
    let failing = true;
    rt.net.on("https://api.telegram.org/", (req) => {
      const text = String(req.json().text ?? "");
      if (req.method_ !== "sendMessage" || !text.includes("Entry")) return Response.json({ ok: true, result: { message_id: 1, date: 0, chat: { id: 1, type: "private" } } });
      tries.push(/\((\d+)\/4\)$/.exec(text)?.[1] ?? "?");
      if (failing && text.endsWith("(3/4)")) return Response.json({ ok: false, error_code: 500, description: "Internal Server Error" }, { status: 500 });
      return Response.json({ ok: true, result: { message_id: 1, date: 0, chat: { id: 1, type: "private" } } });
    });
    await deliverTelegram(rt);
    expect(tries).toEqual(["1", "2", "3"]);
    expect((await db.select().from(schema.agentMessages).where(eq(schema.agentMessages.id, m!.id)))[0]).toMatchObject({ tgState: "pending", tgParts: 2, tgAttempts: 1 });
    failing = false;
    await deliverTelegram(rt);
    expect(tries).toEqual(["1", "2", "3", "3", "4"]);
    expect((await db.select().from(schema.agentMessages).where(eq(schema.agentMessages.id, m!.id)))[0]).toMatchObject({ tgState: "sent", tgParts: 4 });
  });

  it("goes again as plain text when Telegram can't read the HTML", async () => {
    resetTelegramHolds();
    const owner = await addUser(db, "owner2");
    const inst = await installed(rt, owner, await publishedAgent(db, owner));
    let refused = 0;
    rt.net.on("https://api.telegram.org/", (req) => {
      if (req.method_ === "sendMessage" && req.json().parse_mode === "HTML" && refused++ === 0) return Response.json({ ok: false, description: "Bad Request: can't parse entities: unsupported start tag" }, { status: 400 });
      return Response.json({ ok: true, result: { message_id: 1, date: 0, chat: { id: 1, type: "private" } } });
    });
    await db.insert(schema.agentMessages).values({ installationId: inst.id, from: "agent", text: "**Done**", tgState: "pending", createdAt: rt.now() });
    await deliverTelegram(rt);
    const [last] = rt.net.telegram("sendMessage").slice(-1);
    expect(last).toMatchObject({ text: "Fabric restock: Done" });
    expect(last!.parse_mode).toBeUndefined();
  });
});
