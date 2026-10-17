import { eq } from "drizzle-orm";
import { z } from "zod";
import { getUserFromRequest } from "@/lib/auth-route";
import { verifySiwe } from "@/lib/openserv";
import { encryptSecret } from "@/lib/crypto";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";

export const runtime = "nodejs";

const Body = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  message: z.string().min(1),
  signature: z.string().min(1),
});

// Step two: hand OpenServ the signed message, receive the user's OpenServ API
// key, encrypt it, and store only the ciphertext. The key is never returned to
// the browser.
export async function POST(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "The signed message was incomplete" }, { status: 400 });

  try {
    const result = await verifySiwe(parsed.data.address, parsed.data.message, parsed.data.signature);
    const encrypted = encryptSecret(result.apiKey);
    await db
      .update(users)
      .set({
        openservUserId: result.openservUserId,
        openservKeyEncrypted: encrypted,
        walletAddress: parsed.data.address,
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id));
    return Response.json({ ok: true, openservUserId: result.openservUserId });
  } catch {
    return Response.json({ error: "OpenServ did not accept the sign-in. Try again." }, { status: 502 });
  }
}
