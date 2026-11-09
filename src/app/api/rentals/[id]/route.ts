import { getUserFromRequest } from "@/lib/auth-route";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { rentalDTOs, rentalOf, rentalSetup } from "@/lib/market/rentals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One rental, for its renter only; with what setting it up asks while it
// isn't set up (its questions, rules and schedule: never its code).
export async function GET(req: Request, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const rt = serverRuntime();
  const r = await rentalOf(rt, user.id, params.id);
  if (!r) return Response.json({ error: "Not found" }, { status: 404 });
  const [rental] = await rentalDTOs(rt, [r]);
  return Response.json({ rental, setup: rental!.status === "setup" ? await rentalSetup(rt, r) : null });
}
