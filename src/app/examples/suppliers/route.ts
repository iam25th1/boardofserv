import { SUPPLIERS_HTML } from "@/lib/agents/examples/supplierPage";

// The example restock agent's suppliers' price list, public: made-up,
// neutral prices in USDC, for its web.fetch to read for real.
export function GET() {
  return new Response(SUPPLIERS_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=3600" } });
}
