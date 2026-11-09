import { serverRuntime } from "@/lib/agents/runtime/context";
import { boardHelpers } from "@/lib/helpers";
import { boardAgents, type Connects } from "@/lib/market/listings";
import { USDC_DECIMALS } from "@/lib/market/charges";
import { parseAmount } from "@/lib/money";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CONNECTS: Connects[] = ["telegram", "sheets", "web"];

// The board, for anyone: helpers and agents on it. ?q= searches names (and
// what an agent does); ?kind=helpers or agents shows one; ?connects=
// telegram,sheets,web keeps agents that connect to all of those; ?min= and
// ?max= bound an agent's weekly price, in whole USDC; ?sort=quality puts
// the highest quality first and ?quality=N keeps agents scored N or more.
// Public fields only.
export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const q = p.get("q") ?? "";
  const kind = p.get("kind");
  const connects = (p.get("connects") ?? "").split(",").filter((c): c is Connects => (CONNECTS as string[]).includes(c));
  const bound = (v: string | null) => (v && v.trim() ? parseAmount(v.trim(), USDC_DECIMALS) : null);
  const minQuality = /^\d{1,3}$/.test(p.get("quality") ?? "") ? Math.min(100, Number(p.get("quality"))) : null;
  const filtered = connects.length > 0 || bound(p.get("min")) !== null || bound(p.get("max")) !== null || minQuality !== null;
  const [helpers, agents] = await Promise.all([
    // Helpers connect to nothing and have no weekly price: those filters are about agents.
    kind === "agents" || filtered ? [] : boardHelpers(q),
    kind === "helpers" ? [] : boardAgents(serverRuntime(), { q, connects, min: bound(p.get("min")), max: bound(p.get("max")), sort: p.get("sort") === "quality" ? "quality" : "rented", minQuality }),
  ]);
  return Response.json({ helpers, agents });
}
