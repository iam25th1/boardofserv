import { SUPPLIERS_HTML } from "@/lib/agents/examples/supplierPage";
import { rateLimited } from "@/lib/rateLimit";

// The example restock agent's suppliers' price list, public: made-up,
// neutral prices in USDC, for its web.fetch to read for real.
export function GET(req: Request) {
  const limited = rateLimited(req, "page");
  if (limited) return limited;
  return new Response(SUPPLIERS_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=3600" } });
}
