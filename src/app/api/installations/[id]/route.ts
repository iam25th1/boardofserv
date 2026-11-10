import { z } from "zod";
import { getUserFromRequest } from "@/lib/auth-route";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { installationDTO, loadInstallation, ownedInstallation, setModelBudget, setPolicy } from "@/lib/agents/runtime/installations";
import { budgetConfig, usdcWords } from "@/lib/agents/metering";
import { TOOL_NAMES } from "@/lib/agents/definition";
import { MAX_AUTO_SPEND_USDC } from "@/lib/agents/risk";

export const runtime = "nodejs";

// One installation, for its owner only: a 404 for anyone else.
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const params = await ctx.params;
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const rt = serverRuntime();
  const loaded = await ownedInstallation(rt, user.id, params.id);
  if (!loaded) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ installation: await installationDTO(rt, loaded) });
}

const Policy = z.union([
  z.object({
    askFor: z.array(z.enum(TOOL_NAMES)).max(TOOL_NAMES.length),
    autoSpendUsdc: z.number().finite().min(0).max(MAX_AUTO_SPEND_USDC),
  }),
  // The weekly model budget, USDC minor units; null for the maker's default.
  z.object({ modelBudget: z.string().regex(/^\d{1,78}$/).nullable() }),
]);

// Its owner raises what asks first, sets how much it may spend per call
// without asking, or sets its weekly model budget (within the platform's
// ceiling). Nobody lowers the platform's floor: reads can't ask, money
// above the auto limit always does.
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const params = await ctx.params;
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const rt = serverRuntime();
  const loaded = await ownedInstallation(rt, user.id, params.id);
  if (!loaded) return Response.json({ error: "Not found" }, { status: 404 });
  const parsed = Policy.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: `Say which tools ask first and an auto limit from 0 to ${MAX_AUTO_SPEND_USDC} USDC, or a weekly model budget.` }, { status: 400 });
  if ("modelBudget" in parsed.data) {
    const ceiling = budgetConfig().ceiling;
    const budget = parsed.data.modelBudget === null ? null : BigInt(parsed.data.modelBudget);
    if (budget !== null && budget > ceiling) return Response.json({ error: `A weekly model budget can be at most ${usdcWords(ceiling)}.` }, { status: 400 });
    await setModelBudget(rt, loaded, budget);
  } else await setPolicy(rt, loaded, parsed.data);
  return Response.json({ installation: await installationDTO(rt, (await loadInstallation(rt, loaded.installation.id))!) });
}
