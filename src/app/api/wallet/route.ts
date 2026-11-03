import { getUserFromRequest } from "@/lib/auth-route";
import { walletDTO } from "@/lib/payments/dto";

export const runtime = "nodejs";

// The signed-in user's balances, linked wallets and recent deposits. Loading
// it brings the linked wallets in step with Privy, so a wallet linked a
// moment ago is matched from then on.
export async function GET(req: Request) {
  const user = await getUserFromRequest(req, { wallets: true });
  if (!user) return Response.json({ error: "Sign in to see your wallet." }, { status: 401 });
  return Response.json({ wallet: await walletDTO(user.id) });
}
