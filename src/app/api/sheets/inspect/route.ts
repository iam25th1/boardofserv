import { z } from "zod";
import { getUserFromRequest } from "@/lib/auth-route";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { hasConnection } from "@/lib/connections/vault";
import { GoogleRevoked, GoogleUnavailable } from "@/lib/google/oauth";
import { parseSheetLink } from "@/lib/google/sheetLink";
import { SheetRefused, sheetInfo } from "@/lib/google/sheets";

export const runtime = "nodejs";

const Body = z.object({ url: z.string().trim().min(1).max(2000) });

// A Google Sheet the owner pasted a link to, opened on their own Google
// access: its name and tabs, to pick one from. Nothing is kept.
export async function POST(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  const link = parsed.success ? parseSheetLink(parsed.data.url) : null;
  if (!link) return Response.json({ error: "Paste the link of a Google Sheet (docs.google.com/spreadsheets/...)." }, { status: 400 });
  const rt = serverRuntime();
  if (!rt.services.google) return Response.json({ error: "Google isn't set up here." }, { status: 503 });
  if (!(await hasConnection(rt, user.id, "google"))) return Response.json({ error: "Connect Google first, on Connections." }, { status: 409 });
  try {
    const info = await sheetInfo(rt, user.id, link.spreadsheetId);
    return Response.json({ title: info.title, tabs: info.tabs });
  } catch (err) {
    if (err instanceof SheetRefused) return Response.json({ error: err.message }, { status: 422 });
    if (err instanceof GoogleRevoked) return Response.json({ error: "Google stopped letting boardofserv in. Connect Google again on Connections." }, { status: 409 });
    if (err instanceof GoogleUnavailable) return Response.json({ error: "Google couldn't be reached just now. Try again in a minute." }, { status: 503 });
    throw err;
  }
}
