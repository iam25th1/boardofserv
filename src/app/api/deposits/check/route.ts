import { getUserFromRequest } from "@/lib/auth-route";
import { paymentsConfig } from "@/lib/payments/config";
import { scanTick } from "@/lib/payments/deposits";
import { walletDTO } from "@/lib/payments/dto";

export const runtime = "nodejs";

// "Check for my deposit": bring the linked wallets in step with Privy, run
// the deposit watcher now, and return the user's wallet. At most once every
// few seconds per user; a sooner press just returns the wallet.
const COOLDOWN_MS = 10_000;
const lastCheck = new Map<string, number>();

export async function POST(req: Request) {
  const user = await getUserFromRequest(req, { wallets: true });
  if (!user) return Response.json({ error: "Sign in to check for a deposit." }, { status: 401 });
  if (!paymentsConfig().enabled) return Response.json({ error: "Payments aren't set up here." }, { status: 503 });
  const now = Date.now();
  if (now - (lastCheck.get(user.id) ?? 0) >= COOLDOWN_MS) {
    if (lastCheck.size > 1000) for (const [id, at] of lastCheck) if (now - at >= COOLDOWN_MS) lastCheck.delete(id);
    lastCheck.set(user.id, now);
    await scanTick();
  }
  return Response.json({ wallet: await walletDTO(user.id) });
}
