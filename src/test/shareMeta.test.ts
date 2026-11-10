// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "./helperDb";
import { publishedAgent } from "./runtimeFixtures";

// What a shared link shows: the front page and the public pages with the
// beta's words and the chalk card; an agent's page with its own name and
// what it does; and the card itself, a real 1200 by 630 image in the repo.

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: (_, key) => Reflect.get(state.db as object, key) }) }));

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
beforeAll(async () => {
  ({ client, db } = await testDb());
  state.db = db;
});
afterAll(async () => client.close());

type Meta = { title?: unknown; description?: unknown; openGraph?: { title?: unknown; description?: unknown; images?: { url: string; width: number; height: number }[] }; twitter?: { card?: string; images?: unknown[] }; metadataBase?: URL };

describe("share cards", () => {
  it("are on the front page: the beta's words, the card, a large X card", async () => {
    const { rootMetadata: metadata } = (await import("@/lib/shareMeta")) as unknown as { rootMetadata: Meta };
    expect(metadata.metadataBase?.toString()).toBe("https://boardofserv.25th.dev/");
    expect(metadata.title).toBe("boardofserv");
    expect(String(metadata.description)).toMatch(/Small agents that do one job for you, every week\..*A beta, on test USDC\.$/);
    expect(metadata.openGraph?.images?.[0]).toMatchObject({ url: "/brand/share-card.png", width: 1200, height: 630 });
    expect(metadata.twitter?.card).toBe("summary_large_image");
    expect(JSON.stringify(metadata)).not.toMatch(/OpenServ|draft/i);
    expect(JSON.stringify(metadata)).not.toContain(String.fromCharCode(0x2014));
  });

  it("are on every public page, with its own title", async () => {
    for (const [path, title] of [["about", "About boardofserv"], ["terms", "Using the beta"], ["privacy", "Your data"], ["support", "Support"]]) {
      const { metadata } = (await import(`@/app/${path}/page`)) as { metadata: Meta };
      expect(metadata.title, path).toBe(title);
      expect(metadata.openGraph?.title, path).toBe(title);
      expect(metadata.twitter?.card, path).toBe("summary_large_image");
    }
  });

  it("show an agent's own name and what it does, and the board's words for anything else", async () => {
    const maker = await addUser(db, "share.maker", "share_maker");
    const p = await publishedAgent(db, maker);
    await db.insert(schema.agentListings).values({ agentId: p.agent.id, versionId: p.version.id, weeklyPrice: "0", jobFee: "0", listed: true });
    const { generateMetadata } = await import("@/app/app/board/agents/[id]/layout");
    const m = (await generateMetadata({ params: Promise.resolve({ id: p.agent.id }) })) as Meta;
    expect(m.title).toBe(`${p.agent.name} on boardofserv`);
    expect(String(m.description)).toMatch(/A beta, on test USDC\.$/);
    expect(m.openGraph?.images?.[0]?.url).toBe("/brand/share-card.png");
    for (const id of ["00000000-0000-0000-0000-000000000000", "not-an-id", "'; drop table agents; --"]) {
      expect(((await generateMetadata({ params: Promise.resolve({ id }) })) as Meta).title, id).toBe("An agent on boardofserv");
    }
  });

  it("use a real 1200 by 630 PNG in the repo", () => {
    const png = readFileSync(join(process.cwd(), "public/brand/share-card.png"));
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(1200);
    expect(png.readUInt32BE(20)).toBe(630);
    const logo = readFileSync(join(process.cwd(), "public/brand/logo-120.png"));
    expect([logo.readUInt32BE(16), logo.readUInt32BE(20)]).toEqual([120, 120]);
  });
});
