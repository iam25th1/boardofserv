import "server-only";
import { getUserFromRequest } from "@/lib/auth-route";
import type { User } from "@/lib/db/schema";
import { isAdmin } from "@/lib/payments/admin";

// The signed-in admin, or the response that refuses everyone else: 401
// signed out, 404 for anyone not named in ADMIN_USER_IDS (the page does not
// say it exists).
export async function requireAdmin(req: Request): Promise<{ admin: User } | { refused: Response }> {
  const user = await getUserFromRequest(req);
  if (!user) return { refused: Response.json({ error: "Not signed in" }, { status: 401 }) };
  if (!isAdmin(user)) return { refused: Response.json({ error: "Not found" }, { status: 404 }) };
  return { admin: user };
}
