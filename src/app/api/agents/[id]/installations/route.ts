import { z } from "zod";
import { notLetIn } from "@/lib/access";
import { ownedAgent } from "@/lib/agents/owned";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { install, installationDTO, InstallRefused, loadInstallation } from "@/lib/agents/runtime/installations";
import { versionsOf } from "@/lib/agents/store";

export const runtime = "nodejs";

const Body = z.object({
  settings: z.record(z.string(), z.unknown()),
  rules: z.record(z.string(), z.string().max(200)),
  timezone: z.string().max(64),
  schedule: z.object({ at: z.string().max(5).nullable(), day: z.number().int().nullable() }).nullable().optional(),
  minGapMinutes: z.number().optional(),
  dailySpendUsd: z.number().optional(),
  // How much it may spend per call without asking, in USDC.
  autoSpendUsdc: z.number().finite().min(0).max(1000).optional(),
  // false: set it up for a test run first; it goes live when its owner says.
  live: z.boolean().optional(),
});

// Run it for real: the maker installs the newest published version of their
// own agent for themselves, with their answers to its settings questions.
// (Installing someone else's agent comes with renting.)
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const who = await ownedAgent(req, params.id);
  if ("refused" in who) return who.refused;
  const shut = notLetIn(who.user);
  if (shut) return shut;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Send your answers, rules and time zone." }, { status: 400 });
  const version = (await versionsOf(who.agent.id)).find((v) => v.state === "published");
  if (!version) return Response.json({ error: "Publish a version first: an installation runs a published version, which never changes." }, { status: 409 });
  const rt = serverRuntime();
  try {
    const { live, ...answers } = parsed.data;
    const row = await install(rt, { ownerUserId: who.user.id, agent: who.agent, version, answers, live });
    const loaded = await loadInstallation(rt, row.id);
    return Response.json({ installation: await installationDTO(rt, loaded!) }, { status: 201 });
  } catch (err) {
    if (err instanceof InstallRefused) return Response.json({ error: err.message, errors: err.errors }, { status: 400 });
    throw err;
  }
}
