import { serverRuntime } from "@/lib/agents/runtime/context";
import { CallbackRefused, finishGoogle, GoogleUnavailable, STATE_COOKIE } from "@/lib/google/oauth";
import { rateLimited } from "@/lib/rateLimit";

export const runtime = "nodejs";

// Google sends the owner back here. The state must match this browser's
// cookie and the one kept for the owner who started; then the code is
// exchanged and the tokens go into the vault. Either way the owner lands
// back on the page they came from, told how it went, and the cookie goes.
export async function GET(req: Request) {
  const limited = rateLimited(req, "callback");
  if (limited) return limited;
  const rt = serverRuntime();
  const q = new URL(req.url).searchParams;
  const cookie =
    req.headers
      .get("cookie")
      ?.split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${STATE_COOKIE}=`))
      ?.slice(STATE_COOKIE.length + 1) ?? null;
  const site = rt.services.google ? new URL(rt.services.google.redirectUri).origin : new URL(req.url).origin;
  const back = (to: string, params: Record<string, string>) => {
    const u = new URL(to, site);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return new Response(null, { status: 303, headers: { location: u.toString(), "set-cookie": `${STATE_COOKIE}=; Path=/api/connections/google; HttpOnly; SameSite=Lax; Max-Age=0` } });
  };
  try {
    const done = await finishGoogle(rt, { state: q.get("state"), cookie, code: q.get("code"), error: q.get("error") });
    return back(done.returnTo, { google: "connected" });
  } catch (err) {
    if (err instanceof CallbackRefused) return back(err.returnTo, { google: "refused", why: err.message });
    if (err instanceof GoogleUnavailable) return back("/app/connections", { google: "refused", why: "Google couldn't be reached just now. Try again in a minute." });
    throw err;
  }
}
