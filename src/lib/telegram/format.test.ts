// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { installed, publishedAgent, testRuntime, type TestRuntime } from "@/test/runtimeFixtures";
import { deliverTelegram, resetTelegramHolds } from "./deliver";
import { plainText, telegramHtml } from "./format";

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
