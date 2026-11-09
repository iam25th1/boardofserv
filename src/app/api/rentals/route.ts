import { getUserFromRequest } from "@/lib/auth-route";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { rentalsOf } from "@/lib/market/rentals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The agents the signed-in user rents, for them only.
export async function GET(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  return Response.json({ rentals: await rentalsOf(serverRuntime(), user.id) });
}
