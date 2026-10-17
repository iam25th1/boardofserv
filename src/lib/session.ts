import "server-only";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { db } from "./db/index";
import { users, type User } from "./db/schema";
import { verifyPrivyToken } from "./privy";

// Privy stores its access token in this cookie. We verify it on the server and
// map it to our own user row. The user's OpenServ key is never read here; it is
// decrypted only in the routes that call OpenServ.
const PRIVY_COOKIE = "privy-token";

export async function currentIdentity(): Promise<{ userId: string; email: string | null } | null> {
  const token = cookies().get(PRIVY_COOKIE)?.value;
  if (!token) return null;
  try {
    return await verifyPrivyToken(token);
  } catch {
    return null;
  }
}

// Find or create the user row for the signed-in Privy identity.
export async function currentUser(): Promise<User | null> {
  const id = await currentIdentity();
  if (!id) return null;
  const existing = await db.query.users.findFirst({ where: eq(users.privyUserId, id.userId) });
  if (existing) return existing;
  const [created] = await db.insert(users).values({ privyUserId: id.userId, email: id.email }).returning();
  return created ?? null;
}

export async function requireUser(): Promise<User> {
  const user = await currentUser();
  if (!user) throw new Error("not signed in");
  return user;
}
