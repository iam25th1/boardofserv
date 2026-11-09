import { notLetIn } from "@/lib/access";
import { getUserFromRequest } from "@/lib/auth-route";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { rent, rentalDTOs, RentRefused } from "@/lib/market/rentals";

export const runtime = "nodejs";

// Rent an agent on the board: its first week is charged now from the
// renter's balance (90% to its maker, 10% to boardofserv), then they set
// it up. Renewal is weekly while the balance covers it.
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const shut = notLetIn(user);
  if (shut) return shut;
  const rt = serverRuntime();
  try {
    const rental = await rent(rt, { renterUserId: user.id, agentId: params.id });
    return Response.json({ rental: (await rentalDTOs(rt, [rental]))[0] }, { status: 201 });
  } catch (err) {
    if (err instanceof RentRefused) return Response.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
