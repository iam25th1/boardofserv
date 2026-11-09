import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { db } from "./db";
import { users, type User } from "./db/schema";
import { isAdmin } from "./payments/admin";

// Invite-only mode. With INVITE_ONLY on (the default), a signed-in account
// that an admin hasn't approved sees the waitlist instead of the chat, and
// the routes that call a model turn it away. Admins are always let in. The
// board and helper pages stay open to everyone, signed in or not.

export type Access = User["access"];

export function inviteOnly(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.INVITE_ONLY?.trim().toLowerCase();
  if (!raw) return true;
  return !["0", "false", "no", "off"].includes(raw);
}

export function accessOf(user: Pick<User, "id" | "privyUserId" | "access">): Access {
  if (!inviteOnly() || isAdmin(user)) return "approved";
  return user.access;
}

export const WAITING_TEXT = "boardofserv is invite-only for now, and your account is on the list.";
export const REJECTED_TEXT = "boardofserv is invite-only for now, and this account wasn't let in.";

// The response that turns away an account not let in yet, or null.
export function notLetIn(user: Pick<User, "id" | "privyUserId" | "access">): Response | null {
  const access = accessOf(user);
  if (access === "approved") return null;
  return Response.json({ error: access === "waiting" ? WAITING_TEXT : REJECTED_TEXT, access }, { status: 403 });
}

// Accounts waiting to get in, oldest first, for the admin page.
export async function waitingAccounts(): Promise<{ id: string; handle: string; email: string | null; joinedAt: string }[]> {
  const rows = await db
    .select({ id: users.id, handle: users.handle, email: users.email, createdAt: users.createdAt })
    .from(users)
    .where(eq(users.access, "waiting"))
    .orderBy(asc(users.createdAt))
    .limit(200);
  return rows.map((r) => ({ id: r.id, handle: r.handle, email: r.email, joinedAt: r.createdAt.toISOString() }));
}

// An admin's decision on a waiting account. False when it isn't waiting.
export async function decideAccess(userId: string, decision: "approved" | "rejected", adminId: string): Promise<boolean> {
  const rows = await db
    .update(users)
    .set({ access: decision, accessDecidedBy: adminId, accessDecidedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(users.id, userId), eq(users.access, "waiting")))
    .returning({ id: users.id });
  return rows.length > 0;
}
