// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import type * as schema from "@/lib/db/schema";
import { addHelper, addUser, testDb } from "@/test/helperDb";
import { GET } from "./route";

// The board through the real route: newest first, live helpers only, search
// by name, and only public fields.

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: (_, key) => Reflect.get(state.db as object, key) }) }));

let client: PGlite;
let db: PgliteDatabase<typeof schema>;

const board = async (q?: string) => (await (await GET(new Request(`http://localhost/api/board${q === undefined ? "" : `?q=${encodeURIComponent(q)}`}`))).json()).helpers;

beforeAll(async () => {
  ({ client, db } = await testDb());
  state.db = db;
  const maya = await addUser(db, "maya");
  const sam = await addUser(db, "sam");
  const at = (minutes: number) => new Date(Date.UTC(2026, 9, 22, 9, minutes));
  await addHelper(db, maya, { slug: "shop-blurbs", name: "Shop blurbs", description: "Friendly product blurbs", createdAt: at(1) });
  await addHelper(db, sam, { slug: "haiku-maker", name: "Haiku maker", description: "Three lines on anything", createdAt: at(3) });
  await addHelper(db, maya, { slug: "gone", name: "Gone helper", createdAt: at(5), unpublishedAt: at(6) });
  await addHelper(db, sam, { slug: "odd-name", name: "100% _real_ blurbs", createdAt: at(2) });
});

afterAll(async () => {
  await client.close();
});

describe("GET /api/board", () => {
  it("lists live helpers newest first, with public fields only", async () => {
    const helpers = await board();
    expect(helpers.map((h: { slug: string }) => h.slug)).toEqual(["haiku-maker", "odd-name", "shop-blurbs"]);
    expect(helpers[0]).toEqual({
      slug: "haiku-maker",
      name: "Haiku maker",
      description: "Three lines on anything",
      inputHint: "A product and a few facts",
      maker: "sam",
      createdAt: "2026-10-22T09:03:00.000Z",
    });
  });

  it("searches by name, ignoring case, with % and _ taken literally", async () => {
    expect((await board("BLURB")).map((h: { slug: string }) => h.slug)).toEqual(["odd-name", "shop-blurbs"]);
    expect((await board("100%")).map((h: { slug: string }) => h.slug)).toEqual(["odd-name"]);
    expect(await board("_")).toHaveLength(1);
    expect(await board("gone")).toEqual([]);
    expect(await board("   ")).toHaveLength(3);
  });
});
