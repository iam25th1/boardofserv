import { describe, expect, it } from "vitest";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { connections } from "../db/schema";
import { AUTH_KINDS, CATALOG, CATEGORIES, CONNECTABLE_IDS, entryOf, needsConnecting, serviceName, serviceOfTool } from "./catalog";

// The catalog: one entry per service, each saying how it is connected,
// where its calls may go, how a key is checked and where to get one.

describe("the catalog", () => {
  it("has one entry per service, each complete", () => {
    const ids = CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of CATALOG) {
      expect(e.id, e.id).toMatch(/^[a-z][a-z0-9]*$/);
      expect(CATEGORIES.map((c) => c.id), e.id).toContain(e.category);
      expect(AUTH_KINDS, e.id).toContain(e.auth);
      expect(e.hosts.length, e.id).toBeGreaterThan(0);
      if (e.id !== "custom") expect(e.base, e.id).toMatch(/^https:\/\//);
      expect(e.reads.length, e.id).toBeGreaterThan(5);
      expect(e.keyHow.length, e.id).toBeGreaterThan(5);
      // A pasted key is checked when it is saved, and the owner is told
      // where to get one.
      if (["api_key", "bearer", "bot_token", "webhook_url"].includes(e.auth) && e.id !== "custom") {
        expect(e.fields.some((f) => f.secret), e.id).toBe(true);
        expect(e.keyUrl, e.id).toMatch(/^https:\/\//);
        expect(e.check ?? e.auth === "webhook_url", e.id).toBeTruthy();
      }
      // Every host a call may reach is the base's host or one of its own
      // (a Custom API's is the owner's own address).
      if (e.hosts.includes("*") || e.id === "custom") continue;
      const baseHost = new URL(e.base.replace(/\{[a-z]+\}/g, "x")).host;
      expect(e.hosts.map((h) => h.replace(/\{[a-z]+\}/g, "x")), e.id).toContain(baseHost);
    }
  });

  it("keeps Telegram, Google and Typeform as they were", () => {
    expect(entryOf("telegram")).toMatchObject({ auth: "chat", writesOn: true, tools: ["telegram.send", "telegram.ask"] });
    expect(entryOf("google")).toMatchObject({ auth: "oauth", writesOn: true });
    expect(entryOf("typeform")).toMatchObject({ auth: "bearer", writes: null, tools: ["typeform.read"] });
    // Its personal token is kept as it always was, under "token".
    expect(entryOf("typeform")!.fields.map((f) => f.key)).toEqual(["token"]);
    expect(serviceName("google")).toBe("Google");
    expect(serviceName("typeform")).toBe("Typeform");
    expect(serviceOfTool("typeform.read")!.id).toBe("typeform");
    expect(serviceOfTool("sheets.update")!.id).toBe("google");
    expect(needsConnecting(entryOf("telegram")!)).toBe(true);
  });

  it("is what the database lets a connection be", () => {
    const check = getTableConfig(connections).checks.find((c) => c.name === "connections_provider")!;
    const sql = new PgDialect().sqlToQuery(check.value).sql;
    for (const id of CONNECTABLE_IDS) expect(sql).toContain(`'${id}'`);
  });
});
