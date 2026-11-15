// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "@/lib/db/schema";
import { palette } from "@/design/palette";
import manifest from "@/app/manifest";
import robots from "@/app/robots";
import { addUser, testDb } from "./helperDb";
import { publishedAgent } from "./runtimeFixtures";

// What browsers and crawlers ask for besides the pages: the icons, the web
// manifest, robots.txt and the sitemap with the board's agents.

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: (_, key) => Reflect.get(state.db as object, key) }) }));

const ROOT = process.cwd();
const png = (path: string) => readFileSync(join(ROOT, path));
const sizeOf = (file: Buffer) => [file.readUInt32BE(16), file.readUInt32BE(20)];

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let sitemap: () => Promise<{ url: string; lastModified?: string | Date }[]>;
beforeAll(async () => {
  ({ client, db } = await testDb());
  state.db = db;
  ({ default: sitemap } = await import("@/app/sitemap"));
}, 60_000);
afterEach(() => {
  state.db = db;
  vi.useRealTimers();
});
afterAll(async () => client.close());

describe("the icons", () => {
  it("draw the mark in the dark theme's chalk on its slate", () => {
    const svg = readFileSync(join(ROOT, "src/app/icon.svg"), "utf8");
    expect(svg).toContain(`fill="${palette.dark.slate}"`);
    expect(svg).toContain(`stroke="${palette.dark.chalk}"`);
    expect(svg).toMatch(/viewBox="0 0 32 32"/);
  });

  it("have a 32 by 32 favicon.ico, with a 16 by 16 beside it", () => {
    const ico = png("src/app/favicon.ico");
    expect([ico.readUInt16LE(0), ico.readUInt16LE(2)]).toEqual([0, 1]);
    const entries = Array.from({ length: ico.readUInt16LE(4) }, (_, i) => {
      const at = 6 + 16 * i;
      const image = ico.subarray(ico.readUInt32LE(at + 12), ico.readUInt32LE(at + 12) + ico.readUInt32LE(at + 8));
      return { size: [ico[at], ico[at + 1]], image };
    });
    expect(entries.map((e) => e.size)).toEqual([
      [32, 32],
      [16, 16],
    ]);
    for (const e of entries) {
      expect(e.image.subarray(1, 4).toString()).toBe("PNG");
      expect(sizeOf(e.image)).toEqual(e.size);
    }
  });

  it("have a 180 by 180 apple icon with no see-through corners", () => {
    const apple = png("src/app/apple-icon.png");
    expect(sizeOf(apple)).toEqual([180, 180]);
    // Colour type 2: RGB, no alpha (a phone would fill see-through parts with black).
    expect(apple[25]).toBe(2);
  });
});

describe("the web manifest", () => {
  it("names boardofserv, describes the beta and opens the front page", () => {
    const m = manifest();
    expect(m).toMatchObject({ name: "boardofserv", short_name: "boardofserv", start_url: "/", display: "standalone", theme_color: palette.dark.slate, background_color: palette.dark.slate });
    expect(m.description).toBe("Build an agent with SERV Reasoning at its core and rent it out. Or rent one that's already working. A beta, on test USDC.");
  });

  it("lists 192 and 512 icons, and a maskable 512, each a real PNG of its size", () => {
    const icons = manifest().icons ?? [];
    expect(icons.map((i) => [i.sizes, i.purpose])).toEqual([
      ["192x192", "any"],
      ["512x512", "any"],
      ["512x512", "maskable"],
    ]);
    for (const icon of icons) {
      const file = png(join("public", icon.src));
      expect(file.subarray(1, 4).toString(), icon.src).toBe("PNG");
      expect(sizeOf(file).join("x"), icon.src).toBe(icon.sizes);
    }
    // A mask may cut anything outside the middle 80%: the maskable one is
    // full slate to its edges, and its corners are as opaque as its middle.
    expect(png("public/brand/icon-maskable-512.png")[25]).toBe(2);
  });
});

describe("robots.txt", () => {
  it("opens the public pages and the board, and closes the API and the rest of the app", () => {
    const r = robots();
    expect(r.rules).toEqual({ userAgent: "*", allow: ["/", "/app/board"], disallow: ["/api/", "/app/"] });
    expect(r.sitemap).toBe("https://boardofserv.25th.dev/sitemap.xml");
  });
});

describe("the sitemap", () => {
  it("lists the public pages and every agent on the board, and nothing off it", async () => {
    const maker = await addUser(db, "sitemap.maker", "sitemap_maker");
    const listed = await publishedAgent(db, maker);
    const unlisted = await publishedAgent(db, maker);
    await db.insert(schema.agentListings).values([
      { agentId: listed.agent.id, versionId: listed.version.id, listed: true },
      { agentId: unlisted.agent.id, versionId: unlisted.version.id, listed: false },
    ]);
    const urls = (await sitemap()).map((e) => e.url);
    expect(urls.slice(0, 8)).toEqual(["/", "/everything", "/about", "/app/board", "/support", "/terms", "/privacy", "/login"].map((p) => `https://boardofserv.25th.dev${p}`));
    expect(urls).toContain(`https://boardofserv.25th.dev/app/board/agents/${listed.agent.id}`);
    expect(urls.join(" ")).not.toContain(unlisted.agent.id);
    expect((await sitemap()).find((e) => e.url.endsWith(listed.agent.id))?.lastModified).toBeInstanceOf(Date);
  });

  it("has the public pages alone when the database can't answer", async () => {
    state.db = {
      select: () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:5433");
      },
    };
    expect((await sitemap()).map((e) => e.url)).toHaveLength(8);
  });

  it("has the public pages alone when the database takes too long", async () => {
    vi.useFakeTimers();
    const never: unknown = new Proxy(() => undefined, { get: (_, key) => (key === "then" ? () => undefined : () => never) });
    state.db = never;
    const answer = sitemap();
    await vi.advanceTimersByTimeAsync(3000);
    expect((await answer).map((e) => e.url)).toHaveLength(8);
  });
});
