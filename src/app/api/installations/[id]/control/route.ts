import { z } from "zod";
import { notLetIn } from "@/lib/access";
import { getUserFromRequest } from "@/lib/auth-route";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { control, ControlRefused, installationDTO, loadInstallation, ownedInstallation } from "@/lib/agents/runtime/installations";

export const runtime = "nodejs";

const Body = z.object({ action: z.enum(["pause", "resume", "stop", "run", "test", "golive"]) });

// The owner pauses, resumes or stops their installation, or runs it now;
// while it is being set up, runs a test or makes it live.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const params = await ctx.params;
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const rt = serverRuntime();
  const loaded = await ownedInstallation(rt, user.id, params.id);
  if (!loaded) return Response.json({ error: "Not found" }, { status: 404 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Say pause, resume, stop, run, test or golive." }, { status: 400 });
  // Running costs model spend: only for accounts let in.
  if (parsed.data.action !== "pause" && parsed.data.action !== "stop") {
    const shut = notLetIn(user);
    if (shut) return shut;
  }
  try {
    await control(rt, loaded, parsed.data.action);
  } catch (err) {
    if (err instanceof ControlRefused) return Response.json({ error: err.message }, { status: 409 });
    throw err;
  }
  return Response.json({ installation: await installationDTO(rt, (await loadInstallation(rt, loaded.installation.id))!) });
}
