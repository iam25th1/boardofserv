import "server-only";
import { eq } from "drizzle-orm";
import { db } from "./db/index";
import { users, type User } from "./db/schema";
import { verifyPrivyToken } from "./privy";

// Resolve the signed-in user for an API route. Accepts the Privy access token
// from an Authorization bearer header (the client sends it) or the privy-token
// cookie. Returns null when there is no valid token.
export async function getUserFromRequest(req: Request): Promise<User | null> {
  const header = req.headers.get("authorization");
  const bearer = header?.toLowerCase().startsWith("bearer ") ? header.slice(7) : null;
  const cookieToken = req.headers
    .get("cookie")
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith("privy-token="))
    ?.slice("privy-token=".length);
  const token = bearer ?? cookieToken ?? null;
  if (!token) return null;

  let identity;
  try {
    identity = await verifyPrivyToken(token);
  } catch {
    return null;
  }

  const existing = await db.query.users.findFirst({ where: eq(users.privyUserId, identity.userId) });
  if (existing) {
    if (!existing.email && identity.email) {
      await db.update(users).set({ email: identity.email, updatedAt: new Date() }).where(eq(users.id, existing.id));
    }
    return existing;
  }
  const [created] = await db.insert(users).values({ privyUserId: identity.userId, email: identity.email }).returning();
  return created ?? null;
}
