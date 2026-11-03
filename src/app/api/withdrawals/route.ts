import { z } from "zod";
import { getUserFromRequest } from "@/lib/auth-route";
import { CURRENCIES } from "@/lib/money";
import { walletDTO, withdrawalDTO } from "@/lib/payments/dto";
import { payoutTick, requestWithdrawal, WithdrawalRefused } from "@/lib/payments/withdrawals";

export const runtime = "nodejs";

const Body = z.object({
  currency: z.enum(CURRENCIES),
  // Minor units, as a string of digits.
  amount: z.string().regex(/^\d{1,78}$/),
  to: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  // The browser's key for this request, so a double submit is one withdrawal.
  key: z.string().min(8).max(80),
});

// Ask for a withdrawal to one of your linked wallets. It is debited at once;
// an automatic one is sent within moments, a larger one waits for an admin.
export async function POST(req: Request) {
  const user = await getUserFromRequest(req, { wallets: true });
  if (!user) return Response.json({ error: "Sign in to withdraw." }, { status: 401 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Pick a currency, an amount and one of your linked wallets." }, { status: 400 });
  const { currency, amount, to, key } = parsed.data;
  try {
    const w = await requestWithdrawal({ userId: user.id, currency, amount: BigInt(amount), to, key });
    // Send it now rather than at the next interval. Its errors are logged there.
    if (w.status === "queued") void payoutTick();
    return Response.json({ withdrawal: withdrawalDTO(w), wallet: await walletDTO(user.id) });
  } catch (err) {
    if (err instanceof WithdrawalRefused) return Response.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
