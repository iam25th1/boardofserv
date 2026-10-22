// @vitest-environment node
import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Migration 0008 on a database that already has users: each gets a random
// handle the way new users do, and none is marked chosen.

const DIR = join(__dirname, "../lib/db/migrations");

async function apply(client: PGlite, file: string) {
  for (const statement of readFileSync(join(DIR, file), "utf8").split("--> statement-breakpoint")) {
    if (statement.trim()) await client.exec(statement);
  }
}

describe("migration 0008", () => {
  it("gives every existing user a distinct random handle, not yet chosen", async () => {
    const client = new PGlite();
    const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
    const at = files.indexOf("0008_user_handles.sql");
    for (const file of files.slice(0, at)) await apply(client, file);
    for (let i = 0; i < 40; i++) await client.query("insert into users (privy_user_id, email) values ($1, $2)", [`did:privy:${i}`, `user${i}@example.com`]);

    await apply(client, files[at]!);

    const { rows } = await client.query<{ handle: string; handle_chosen: boolean }>("select handle, handle_chosen from users");
    expect(rows).toHaveLength(40);
    for (const row of rows) {
      expect(row.handle).toMatch(/^maker_\d{4}(\d{4})?$/);
      expect(row.handle_chosen).toBe(false);
    }
    expect(new Set(rows.map((r) => r.handle)).size).toBe(40);
    await expect(client.query("insert into users (privy_user_id) values ('did:privy:none')")).rejects.toThrow();
    await client.close();
  });
});
