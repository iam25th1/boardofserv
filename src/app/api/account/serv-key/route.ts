import { z } from "zod";
import { getUserFromRequest } from "@/lib/auth-route";
import { checkServKey, KEY_CHECK_TEXT, removeServKey, saveServKey } from "@/lib/servKey";

export const runtime = "nodejs";

// A key is one unbroken run of characters.
const Body = z.object({ key: z.string().trim().min(8).max(400).regex(/^\S+$/) });

// Use your own SERV key: checked with one tiny call on its own credit, then
// kept encrypted. The response carries its last four characters only.
export async function POST(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Paste the whole key, with no spaces." }, { status: 400 });

  const check = await checkServKey(parsed.data.key);
  if (check !== "ok") return Response.json({ error: KEY_CHECK_TEXT[check] }, { status: check === "unreachable" ? 502 : 400 });
  try {
    return Response.json({ servKey: await saveServKey(user.id, parsed.data.key) });
  } catch (err) {
    // Only the error's name: its message could carry what was being encrypted.
    console.error(`a SERV key was not saved: ${err instanceof Error ? err.name : "unknown error"}`);
    return Response.json({ error: "Your key couldn't be saved just now. Try again in a few minutes." }, { status: 503 });
  }
}

// Stop using it: the key is deleted, and chat goes back to the site's own.
export async function DELETE(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  await removeServKey(user.id);
  return Response.json({ servKey: null });
}
