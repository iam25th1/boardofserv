import { getUserFromRequest } from "@/lib/auth-route";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { GoogleUnavailable, startGoogle, STATE_COOKIE, STATE_MINUTES } from "@/lib/google/oauth";

export const runtime = "nodejs";

// Connecting Google starts here: Google's address to go to, and the
// sign-in's state in a cookie for this browser, which the callback checks.
export async function POST(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const rt = serverRuntime();
  const body = (await req.json().catch(() => ({}))) as { returnTo?: unknown };
  try {
    const { url, state } = await startGoogle(rt, user.id, typeof body.returnTo === "string" ? body.returnTo : "/app/connections");
    const secure = rt.services.google!.redirectUri.startsWith("https:") ? "; Secure" : "";
    return Response.json(
      { url },
      { headers: { "set-cookie": `${STATE_COOKIE}=${state}; Path=/api/connections/google; HttpOnly; SameSite=Lax; Max-Age=${STATE_MINUTES * 60}${secure}` } },
    );
  } catch (err) {
    if (err instanceof GoogleUnavailable) return Response.json({ error: err.message }, { status: 503 });
    throw err;
  }
}
