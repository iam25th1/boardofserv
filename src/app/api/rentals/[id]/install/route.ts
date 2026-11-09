import { z } from "zod";
import { getUserFromRequest } from "@/lib/auth-route";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { installationDTO, InstallRefused, loadInstallation } from "@/lib/agents/runtime/installations";
import { marketRefusal } from "@/lib/market/limits";
import { installRental, rentalOf, RentRefused } from "@/lib/market/rentals";

export const runtime = "nodejs";

const Body = z.object({
  settings: z.record(z.unknown()),
  rules: z.record(z.string().max(200)),
  timezone: z.string().max(64),
  schedule: z.object({ at: z.string().max(5).nullable(), day: z.number().int().nullable() }).nullable().optional(),
  minGapMinutes: z.number().optional(),
  dailySpendUsd: z.number().optional(),
  // How much it may spend per call without asking, in USDC.
  autoSpendUsdc: z.number().finite().min(0).max(1000).optional(),
});

// The renter sets up the agent they rent, with their answers: it is theirs
// to run, set up for a test run first, live when they say.
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const rt = serverRuntime();
  const shut = await marketRefusal(rt, user, { spends: true });
  if (shut) return shut;
  const r = await rentalOf(rt, user.id, params.id);
  if (!r) return Response.json({ error: "Not found" }, { status: 404 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Send your answers, rules and time zone." }, { status: 400 });
  try {
    const id = await installRental(rt, r, parsed.data);
    return Response.json({ installation: await installationDTO(rt, (await loadInstallation(rt, id))!) }, { status: 201 });
  } catch (err) {
    if (err instanceof InstallRefused) return Response.json({ error: err.message, errors: err.errors }, { status: 400 });
    if (err instanceof RentRefused) return Response.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
