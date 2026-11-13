import { getUserFromRequest } from "@/lib/auth-route";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { CONNECTION_PROVIDERS, type ConnectionProvider } from "@/lib/db/schema";
import { connectionsOf, disconnect } from "@/lib/connections/vault";
import { farewell } from "@/lib/telegram/farewell";

export const runtime = "nodejs";

// The signed-in owner's connections (never a secret), and which services
// can be connected here at all.
export async function GET(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const rt = serverRuntime();
  return Response.json({
    connections: await connectionsOf(rt, user.id),
    // Typeform needs nothing of the site's: the owner brings their own token.
    available: { telegram: Boolean(rt.services.telegramToken), google: Boolean(rt.services.google), typeform: true },
  });
}

// The owner disconnects a service (?provider=telegram, google or typeform): revoked
// where the service allows it, forgotten here, and every installation that
// needs it paused.
export async function DELETE(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const provider = new URL(req.url).searchParams.get("provider") ?? "";
  if (!(CONNECTION_PROVIDERS as readonly string[]).includes(provider)) return Response.json({ error: "Say which: telegram, google or typeform." }, { status: 400 });
  const rt = serverRuntime();
  const done = await disconnect(rt, user.id, provider as ConnectionProvider, provider === "telegram" ? farewell(rt) : undefined);
  if (!done) return Response.json({ error: "It isn't connected." }, { status: 404 });
  return Response.json(done);
}
