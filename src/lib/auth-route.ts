import "server-only";
import { eq } from "drizzle-orm";
import { db } from "./db/index";
import { users, type User } from "./db/schema";
import { verifyPrivyToken } from "./privy";
import { createUser } from "./users";
import { syncWallets } from "./payments/wallets";

// A browser sends the cookie on requests other sites start too. So a change
// (anything but a read) it marks as from another site, or a sibling
// subdomain (same-site), signs in no one from the cookie. The app's own
// calls carry the bearer header, which another site can't send.
function cookieAllowed(req: Request): boolean {
  if (req.method === "GET" || req.method === "HEAD") return true;
  const site = req.headers.get("sec-fetch-site");
  return site !== "cross-site" && site !== "same-site";
}

// Resolve the signed-in user for an API route. Accepts the Privy access token
// from an Authorization bearer header (the client sends it) or the privy-token
// cookie. Returns null when there is no valid token. With `wallets`, the
// user's linked wallets are also brought in step with what Privy reports.
export async function getUserFromRequest(req: Request, opts: { wallets?: boolean } = {}): Promise<User | null> {
  const header = req.headers.get("authorization");
  const bearer = header?.toLowerCase().startsWith("bearer ") ? header.slice(7) : null;
  const cookieToken = cookieAllowed(req)
    ? req.headers
        .get("cookie")
        ?.split(";")
        .map((c) => c.trim())
        .find((c) => c.startsWith("privy-token="))
        ?.slice("privy-token=".length)
    : undefined;
  const token = bearer ?? cookieToken ?? null;
  if (!token) return null;

  let identity;
  try {
    identity = await verifyPrivyToken(token);
  } catch {
    return null;
  }

  let user = (await db.query.users.findFirst({ where: eq(users.privyUserId, identity.userId) })) ?? null;
  if (user) {
    if (!user.email && identity.email) {
      await db.update(users).set({ email: identity.email, updatedAt: new Date() }).where(eq(users.id, user.id));
    }
  } else user = await createUser(identity);
  if (user && opts.wallets && identity.wallets) await syncWallets(user.id, identity.wallets);
  return user;
}
