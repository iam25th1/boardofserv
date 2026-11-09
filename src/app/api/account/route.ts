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
    chat: await chatQuota(user.id),
    paused: await siteLimitReached(),
  });
}
