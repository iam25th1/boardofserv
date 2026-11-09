import { z } from "zod";
import { getUserFromRequest } from "@/lib/auth-route";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { installationDTO, loadInstallation, ownedInstallation, setPolicy } from "@/lib/agents/runtime/installations";
import { TOOL_NAMES } from "@/lib/agents/definition";
import { MAX_AUTO_SPEND_USDC } from "@/lib/agents/risk";

export const runtime = "nodejs";

// One installation, for its owner only: a 404 for anyone else.
export async function GET(req: Request, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const rt = serverRuntime();
  const loaded = await ownedInstallation(rt, user.id, params.id);
  if (!loaded) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ installation: await installationDTO(rt, loaded) });
}

const Policy = z.object({
  askFor: z.array(z.enum(TOOL_NAMES)).max(TOOL_NAMES.length),
  autoSpendUsdc: z.number().finite().min(0).max(MAX_AUTO_SPEND_USDC),
});

// Its owner raises what asks first, or sets how much it may spend per call
// without asking. Nobody lowers the platform's floor: reads can't ask,
// money above the auto limit always does.
export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const rt = serverRuntime();
  const loaded = await ownedInstallation(rt, user.id, params.id);
  if (!loaded) return Response.json({ error: "Not found" }, { status: 404 });
  const parsed = Policy.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: `Say which tools ask first, and an auto limit from 0 to ${MAX_AUTO_SPEND_USDC} USDC.` }, { status: 400 });
  await setPolicy(rt, loaded, parsed.data);
  return Response.json({ installation: await installationDTO(rt, (await loadInstallation(rt, loaded.installation.id))!) });
}
