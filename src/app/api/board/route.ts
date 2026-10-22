import { boardHelpers } from "@/lib/helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The board, for anyone: helpers on it, newest first, with ?q= searching by
// name. Public fields only.
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q") ?? "";
  return Response.json({ helpers: await boardHelpers(q) });
}
