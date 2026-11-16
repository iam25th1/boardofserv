// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { answerItem, askText, CONNECTED_NOW, LATER, LEAVE_OUT, needNotes, needsRequest, openItem, readNeeds, settled, USE_CUSTOM, type JobNeeds } from "./needs";

// Before an agent is planned, what it can't run without is asked: at most
// three short questions with a default to tap, a service it needs that
// isn't connected (with a link back to the same build), and one named that
// isn't in the catalog (Custom API, or leave it out). Make it comes only
// once each is answered or taken at its default.

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: (_, key) => Reflect.get(state.db as object, key) }) }));

const VERIFIER = "i would like a mini agent that checks githubs and verifies code, work, quality.";
const answer = (o: unknown) => JSON.stringify(o);

describe("what the job needs", () => {
  it("asks the GitHub verifier which repositories, what quality means and where results go, with defaults", () => {
    const needs = readNeeds(
      answer({
        needs: [
          { key: "repos", question: "Which repositories should it check?", choices: ["I'll give it at setup", "My public repos"], given: "" },
          { key: "quality_bar", question: "What counts as good quality?", choices: ["Clear, tested changes", "No obvious bugs"], given: "" },
          { key: "results_to", question: "Where should it send what it finds?", choices: ["Telegram", "Discord", "Email"], given: "" },
          { key: "extra", question: "A fourth question?", choices: ["x"], given: "" },
        ],
        services: ["github", "telegram"],
        unlisted: [],
      }),
      VERIFIER,
      new Set(["telegram"]),
    )!;
    expect(needs.items.map((i) => [i.kind, i.key, i.answer])).toEqual([
      ["input", "repos", null],
      ["input", "quality_bar", null],
      ["input", "results_to", null],
    ]);
    // GitHub's public repositories need no key, and Telegram is linked:
    // nothing to connect.
    expect(needs.services).toEqual(["github", "telegram"]);
    expect(openItem(needs)!.choices[0]).toBe("I'll give it at setup");
    expect(askText(needs, openItem(needs)!, "c1", true)).toBe("Before I make it, I need three things from you. Which repositories should it check?");
    // The questions ride under one plain system line; the rules in the request.
    expect(needsRequest("handles: verifies code", [VERIFIER])).toMatch(/at most 3/);
  });

  it("takes what the maker already said as answered", () => {
    const needs = readNeeds(answer({ needs: [{ key: "target", question: "Below what price?", choices: ["2000"], given: "2000" }], services: ["coingecko"], unlisted: [] }), "tell me when ETH is below 2000", new Set())!;
    expect(settled(needs)).toBe(true);
    expect(needNotes(needs)).toEqual([
      'The maker was asked "Below what price?" and answered "2000": that is a setting with given "2000", exactly, read by the steps, never written into a step.',
      "The job uses these services of the catalog, by id: coingecko. Plan no step for any other service.",
    ]);
  });

  it("asks for Discord on an alert agent, with one tap to connect it and come back", () => {
    const needs = readNeeds(answer({ needs: [], services: ["discord", "coingecko"], unlisted: [] }), "alert me on discord when eth drops below 2000", new Set())!;
    const ask = openItem(needs)!;
    expect(ask).toMatchObject({ kind: "service", service: "discord", choices: [LATER, CONNECTED_NOW] });
    expect(askText(needs, ask, "conv-9", true)).toBe("It uses Discord, which isn't connected yet. Connect it now and come back here, or when you set it up.\n\n[Connect Discord](/app/connections?connect=discord&back=%2Fapp%2Fchat%3Fc%3Dconv-9)");
    // Said to be connected when it isn't: asked again.
    const notYet = answerItem({ ...needs, asked: ask.key }, CONNECTED_NOW, new Set());
    expect(openItem(notYet)!.key).toBe(ask.key);
    expect(askText(notYet, openItem(notYet)!, "conv-9", false)).toMatch(/^Discord isn't connected yet\. /);
    // Connected by now: answered.
    expect(settled(answerItem({ ...needs, asked: ask.key }, CONNECTED_NOW, new Set(["discord"])))).toBe(true);
    // Or put off to setup.
    expect(openItem(answerItem({ ...needs, asked: ask.key }, LATER, new Set()))).toBeNull();
  });

  it("offers Custom API for a service that isn't in the catalog, or leaves it out", () => {
    const needs = readNeeds(answer({ needs: [], services: [], unlisted: ["Mastodon"] }), "post my daily summary to Mastodon", new Set())!;
    const ask = openItem(needs)!;
    expect(ask).toMatchObject({ kind: "unlisted", choices: [USE_CUSTOM, LEAVE_OUT] });
    expect(askText(needs, ask, "c", true)).toMatch(/^Mastodon isn't one of the services here\. An agent can reach it through Custom API.*\n\n\[Connect Custom API\]\(\/app\/connections\?connect=custom&back=/);
    const custom = answerItem({ ...needs, asked: ask.key }, USE_CUSTOM, new Set());
    expect(custom.services).toContain("custom");
    expect(needNotes(custom)[0]).toBe('Mastodon isn\'t in the catalog: reach it through custom (Custom API) with service.request or service.send, and list "custom" in services.');
    // Custom API needs connecting: asked about next.
    expect(openItem(custom)).toMatchObject({ kind: "service", service: "custom" });
    const left = answerItem({ ...needs, asked: ask.key }, LEAVE_OUT, new Set());
    expect(needNotes(left)[0]).toBe("Mastodon isn't in the catalog: leave it out, with no step for it.");
  });

  it("keeps the maker's own words, a default tapped, and brings in a service an answer names", () => {
    const needs: JobNeeds = {
      items: [
        { key: "repos", kind: "input", question: "Which repositories should it check?", choices: ["I'll give it at setup"], answer: null },
        { key: "results_to", kind: "input", question: "Where should it send what it finds?", choices: ["Telegram", "Discord"], answer: null },
      ],
      services: ["github"],
      asked: "repos",
      at: "",
    };
    const one = answerItem(needs, "vercel/next.js", new Set());
    expect(one.items[0]!.answer).toBe("vercel/next.js");
    const two = answerItem({ ...one, asked: "results_to" }, "Discord", new Set());
    expect(two.services).toEqual(["github", "discord"]);
    expect(openItem(two)).toMatchObject({ kind: "service", service: "discord" });
    expect(needNotes(two)[0]).toMatch(/answered "vercel\/next\.js": that is a setting with given "vercel\/next\.js"/);
    const later = answerItem(needs, "I'll give it at setup", new Set());
    expect(needNotes(later)[0]).toMatch(/will answer it at setup: it is a setting with no given answer/);
  });

  it("is no answer when SERV's isn't one", () => {
    expect(readNeeds("I can't share that.", "", new Set())).toBeNull();
    expect(readNeeds(answer({ services: [] }), "", new Set())).toBeNull();
  });
});

describe("Make it", () => {
  let client: PGlite;
  let db: PgliteDatabase<typeof schema>;
  beforeAll(async () => {
    ({ client, db } = await testDb());
    state.db = db;
  });
  afterAll(async () => client.close());

  it("waits until every question is answered or taken at its default", async () => {
    const { offerMakeIt, makeIt } = await import("./journey");
    const { saveNeeds } = await import("../sketchStore");
    const maker = await addUser(db, "needs.maker");
    const [convo] = await db.insert(schema.conversations).values({ userId: maker.id }).returning();
    await db.insert(schema.agentSketches).values({ conversationId: convo!.id, kind: "agent", name: "GitHub Code Verifier", wakes: "every morning", looks: "GitHub repositories", handles: "checks code quality" });
    const open: JobNeeds = { items: [{ key: "repos", kind: "input", question: "Which repositories should it check?", choices: ["I'll give it at setup"], answer: null }], services: ["github"], asked: "repos", at: "" };
    await saveNeeds(convo!.id, open);
    expect(await offerMakeIt(convo!.id)).toBeNull();
    expect(await makeIt(maker, convo!.id)).toEqual({ refused: { status: 400, error: "Answer the question above first: the steps are made from it." } });
    await saveNeeds(convo!.id, answerItem(open, "vercel/next.js", new Set()));
    expect((await offerMakeIt(convo!.id))?.card).toEqual({ stage: "describe" });
  });
});
