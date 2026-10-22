import { getUserFromRequest } from "@/lib/auth-route";
import { quotaFor } from "@/lib/helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The signed-in user's helper uses left today, and when they reset.
export async function GET(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  return Response.json({ quota: await quotaFor(user.id) });
}
