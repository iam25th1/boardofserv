// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { errorText, isUniqueViolation, pgCode } from "./errors";

// drizzle-orm 0.44 and later wrap a failed query with its SQL and
// parameters. What the code reads of it stays the database's own code and
// message.

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
beforeAll(async () => {
  ({ client, db } = await testDb());
});
afterAll(async () => client.close());

describe("a failed query", () => {
  it("keeps the database's code, and its words without the query or its parameters", async () => {
    await addUser(db, "errors.first", "taken_handle");
    const err = await db
      .insert(schema.users)
      .values({ privyUserId: "did:privy:errors.second", email: "private-address@example.com", handle: "taken_handle" })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/^Failed query/);
    expect(pgCode(err)).toBe("23505");
    expect(isUniqueViolation(err)).toBe(true);
    const text = errorText(err, "fallback");
    expect(text).toMatch(/duplicate key value/);
    expect(text).not.toMatch(/insert into|private-address|params/);
  });

  it("leaves any other error as it was", () => {
    expect(errorText(new Error("Not enough USDC."), "fallback")).toBe("Not enough USDC.");
    expect(errorText("thrown text", "fallback")).toBe("fallback");
    expect(isUniqueViolation(new Error("x"))).toBe(false);
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
  });
});
