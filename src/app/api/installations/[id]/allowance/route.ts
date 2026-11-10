import { z } from "zod";
import { getUserFromRequest } from "@/lib/auth-route";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { notLetIn } from "@/lib/access";
import { AllowanceRefused, readUsdc, topUp, withdrawAllowance } from "@/lib/spending/allowance";
import { spendingOf } from "@/lib/spending/dto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// An installation's spending allowance, for its renter only (a 404 for
// anyone else): what it holds, its payees, receipts and limits.
export async function GET(req: Request, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const got = await spendingOf(serverRuntime(), user, params.id);
  if (!got) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ spending: got });
}

const Body = z.object({
  action: z.enum(["topup", "withdraw"]),
  // USDC as typed ("5", "2.50"), or "all" to take everything unspent back.
  amount: z.string().max(20),
  // The browser's key for this request: asking twice with it changes nothing more.
  key: z.string().regex(/^[\w-]{8,64}$/),
});

// Top up the allowance from the renter's balance, or take unspent money back.
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const shut = notLetIn(user);
  if (shut) return shut;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Say top up or withdraw, and an amount in USDC like 5 or 2.50." }, { status: 400 });
  const { action, amount, key } = parsed.data;
  const value = action === "withdraw" && amount === "all" ? "all" : readUsdc(amount);
  if (value === null) return Response.json({ error: "Write an amount in USDC like 5 or 2.50, with at most six decimals." }, { status: 400 });
  const rt = serverRuntime();
  try {
    if (action === "topup") await topUp(rt, user, params.id, value as bigint, key);
    else await withdrawAllowance(rt, user, params.id, value, key);
  } catch (err) {
    if (err instanceof AllowanceRefused) return Response.json({ error: err.message }, { status: err.status });
    throw err;
  }
  return Response.json({ spending: await spendingOf(rt, user, params.id) });
}
