import { z } from "zod";
import { getUserFromRequest } from "@/lib/auth-route";
import { HANDLE_TAKEN, handleProblem, normalHandle } from "@/lib/handles";
import { handleTaken, setHandle } from "@/lib/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The signed-in user's handle: GET ?handle= checks one while they type, PATCH
// sets it. Their own handle counts as free, so confirming the random one they
// were given marks it chosen.

export async function GET(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const handle = normalHandle(new URL(req.url).searchParams.get("handle") ?? "").slice(0, 40);
  const problem = handleProblem(handle) ?? ((await handleTaken(handle, user.id)) ? HANDLE_TAKEN : null);
  return Response.json({ handle, available: !problem, ...(problem && { error: problem }) });
}

const Body = z.object({ handle: z.string().max(40) });

export async function PATCH(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "A handle is required." }, { status: 400 });
  const handle = normalHandle(parsed.data.handle);
  const problem = handleProblem(handle);
  if (problem) return Response.json({ error: problem }, { status: 400 });
  if ((await handleTaken(handle, user.id)) || !(await setHandle(user.id, handle))) {
    return Response.json({ error: HANDLE_TAKEN }, { status: 409 });
  }
  return Response.json({ handle, handleChosen: true });
}
