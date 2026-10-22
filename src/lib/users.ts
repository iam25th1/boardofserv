import "server-only";
import { randomInt } from "node:crypto";
import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "./db";
import { users, type User } from "./db/schema";

// A unique violation, from node-postgres or PGlite.
export function isUniqueViolation(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code === "23505");
}

// The handle a new user has until they choose one: maker_ and four digits,
// or eight once four keep colliding. Migration 0008 gave existing users
// theirs the same way.
export function randomHandle(attempt = 0): string {
  return attempt < 5 ? `maker_${randomInt(1000, 10000)}` : `maker_${randomInt(10_000_000, 100_000_000)}`;
}

// The user row for a Privy identity seen for the first time, with a random
// handle. If two first requests race, the second gets the row the first made.
export async function createUser(identity: { userId: string; email: string | null }): Promise<User | null> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const [created] = await db
        .insert(users)
        .values({ privyUserId: identity.userId, email: identity.email, handle: randomHandle(attempt) })
        .onConflictDoNothing({ target: users.privyUserId })
        .returning();
      if (created) return created;
      return (await db.query.users.findFirst({ where: eq(users.privyUserId, identity.userId) })) ?? null;
    } catch (err) {
      // The handle was taken: draw another.
      if (!isUniqueViolation(err)) throw err;
    }
  }
  return null;
}

// Whether someone other than `userId` has this (normal) handle.
export async function handleTaken(handle: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(sql`lower(${users.handle})`, handle), ne(users.id, userId)))
    .limit(1);
  return Boolean(row);
}

// Set the user's handle and mark it chosen. False if someone has it.
export async function setHandle(userId: string, handle: string): Promise<boolean> {
  try {
    await db.update(users).set({ handle, handleChosen: true, updatedAt: new Date() }).where(eq(users.id, userId));
    return true;
  } catch (err) {
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}
