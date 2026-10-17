import { eq } from "drizzle-orm";
import { z } from "zod";
import { getUserFromRequest } from "@/lib/auth-route";
import { getSiweChallenge } from "@/lib/openserv";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";

export const runtime = "nodejs";

const Body = z.object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/) });

// Step one of linking a user's OpenServ account: fetch the SIWE message their
// embedded wallet must sign. The wallet signs in the browser; the signature
// comes back to /finish.
export async function POST(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "A wallet address is required" }, { status: 400 });

  await db.update(users).set({ walletAddress: parsed.data.address, updatedAt: new Date() }).where(eq(users.id, user.id));
  try {
    const challenge = await getSiweChallenge(parsed.data.address);
    return Response.json({ message: challenge.message });
  } catch {
    return Response.json({ error: "OpenServ could not start sign-in. Try again in a moment." }, { status: 502 });
  }
}
