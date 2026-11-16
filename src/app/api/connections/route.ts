import { getUserFromRequest } from "@/lib/auth-route";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { CONNECTION_PROVIDERS, type ConnectionProvider } from "@/lib/db/schema";
import { connectionsOf, disconnect } from "@/lib/connections/vault";
import { CATALOG, type ServiceEntry } from "@/lib/connections/catalog";
import type { Services } from "@/lib/agents/runtime/context";
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
    available: Object.fromEntries(CATALOG.map((e) => [e.id, availableHere(e, rt.services)])),
  });
}

// Whether a service can be connected on this server: Telegram needs the
// site's bot and Google its sign-in; every other service needs nothing of
// the site's, as the owner brings their own key.
function availableHere(e: ServiceEntry, services: Services): boolean {
  if (e.auth === "chat") return Boolean(services.telegramToken);
  if (e.auth === "oauth") return Boolean(services.google);
  return true;
}

// The owner disconnects a service (?provider=telegram, google, typeform or
// any other of the catalog's): revoked
// where the service allows it, forgotten here, and every installation that
// needs it paused.
export async function DELETE(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const provider = new URL(req.url).searchParams.get("provider") ?? "";
  if (!(CONNECTION_PROVIDERS as readonly string[]).includes(provider)) return Response.json({ error: "Say which service to disconnect." }, { status: 400 });
  const rt = serverRuntime();
  const done = await disconnect(rt, user.id, provider as ConnectionProvider, provider === "telegram" ? farewell(rt) : undefined);
  if (!done) return Response.json({ error: "It isn't connected." }, { status: 404 });
  return Response.json(done);
}
