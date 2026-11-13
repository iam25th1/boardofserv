import { accessOf } from "@/lib/access";
import { getUserFromRequest } from "@/lib/auth-route";
import { decryptSecret } from "@/lib/crypto";
import { balanceSufficient } from "@/lib/openserv";
import { isAdmin } from "@/lib/payments/admin";
import { chatQuota, siteLimitReached } from "@/lib/spend";

export const runtime = "nodejs";

// Account state for the account menu: who is signed in, their handle, the
// linked OpenServ account, and whether credit is running or needs topping up.
// OpenServ reports only sufficiency, never an amount, so the client shows a
// state, not a number. This is the one response that carries an email, and
// only ever the signed-in user's own. It also says how many messages are
// left today and whether the day's spend limit has paused the chat.
export async function GET(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });

  const linked = Boolean(user.openservKeyEncrypted);
  const own = Boolean(user.servKeyEncrypted);
  let balance: "ok" | "low" | "unknown" = "unknown";
  if (linked && user.openservKeyEncrypted) {
    try {
      const key = decryptSecret(user.openservKeyEncrypted);
      balance = (await balanceSufficient(key)) ? "ok" : "low";
    } catch {
      balance = "unknown";
    }
  }
  return Response.json({
    email: user.email,
    handle: user.handle,
    handleChosen: user.handleChosen,
    walletAddress: user.walletAddress,
    openservUserId: user.openservUserId,
    linked,
    balance,
    admin: isAdmin(user),
    // "waiting" or "rejected" while invite-only keeps the account out.
    access: accessOf(user),
    // Only the last four characters of the user's own SERV key, never more.
    servKey: user.servKeyLast4 ? { last4: user.servKeyLast4 } : null,
    // Own-key accounts have no daily limit and never pause.
    chat: own ? null : await chatQuota(user.id),
    paused: own ? false : await siteLimitReached(),
    // The agent page shows everything, not the plain view.
    agentDetails: user.agentDetails,
    // Their time zone, as their browser last gave it.
    timezone: user.timezone,
  });
}
