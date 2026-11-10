import { paymentsDTO } from "@/lib/payments/dto";
import { rateLimited } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Whether payments are on, the network, the treasury address deposits go to
// and the currencies it takes. Public: none of it is secret.
export async function GET(req: Request) {
  const limited = rateLimited(req, "read");
  if (limited) return limited;
  return Response.json({ payments: paymentsDTO() });
}
