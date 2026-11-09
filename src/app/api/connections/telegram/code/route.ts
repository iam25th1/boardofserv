import { getUserFromRequest } from "@/lib/auth-route";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { TelegramError } from "@/lib/telegram/api";
import { CodeRefused, newLinkCode } from "@/lib/telegram/link";

export const runtime = "nodejs";

// A one-time code for the owner to send the bot from the chat they want
// linked. It works once, for ten minutes.
export async function POST(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const rt = serverRuntime();
  if (!rt.services.telegramToken) return Response.json({ error: "Telegram isn't set up here." }, { status: 503 });
  try {
    return Response.json(await newLinkCode(rt, user.id), { status: 201 });
  } catch (err) {
    if (err instanceof CodeRefused) return Response.json({ error: err.message }, { status: 429 });
    if (err instanceof TelegramError) return Response.json({ error: "Telegram couldn't be reached just now. Try again in a minute." }, { status: 503 });
    throw err;
  }
}
