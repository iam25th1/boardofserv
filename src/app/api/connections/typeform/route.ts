import { z } from "zod";
import { getUserFromRequest } from "@/lib/auth-route";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { keep } from "@/lib/connections/vault";
import { tokenAccount, TypeformError } from "@/lib/typeform/api";

export const runtime = "nodejs";

const Body = z.object({ token: z.string().trim().min(10).max(400) });

// Connect Typeform: the owner pastes a personal token. It is tried once
// against Typeform (whose account it is), then kept encrypted in the vault
// like every other connection secret, and never shown again: the owner
// sees the account's name and when it was connected. Disconnecting is
// DELETE /api/connections?provider=typeform.
export async function POST(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Paste your Typeform personal token." }, { status: 400 });
  const rt = serverRuntime();
  let account: string;
  try {
    account = await tokenAccount(rt.services.fetch, parsed.data.token);
  } catch (err) {
    const why = err instanceof TypeformError && err.status !== null ? "That token didn't work with Typeform: check it can read forms and responses, or make a new one." : "Typeform couldn't be reached just now. Try again in a minute.";
    return Response.json({ error: why }, { status: err instanceof TypeformError && err.status !== null ? 400 : 503 });
  }
  await keep(rt, user.id, "typeform", `Typeform (${account})`, { token: parsed.data.token });
  return Response.json({ connected: true, label: `Typeform (${account})` });
}
