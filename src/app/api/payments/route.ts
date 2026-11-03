import { paymentsDTO } from "@/lib/payments/dto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Whether payments are on, the network, the treasury address deposits go to
// and the currencies it takes. Public: none of it is secret.
export async function GET() {
  return Response.json({ payments: paymentsDTO() });
}
