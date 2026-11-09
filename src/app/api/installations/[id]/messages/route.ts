import { z } from "zod";
import { notLetIn } from "@/lib/access";
import { getUserFromRequest } from "@/lib/auth-route";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { ownedInstallation } from "@/lib/agents/runtime/installations";
import { MessageRefused, messagesOf, sendToAgent } from "@/lib/agents/runtime/messages";
import type { AgentMessage } from "@/lib/db/schema";
import type { AgentMessageDTO } from "@/lib/types";

export const runtime = "nodejs";

const Body = z.object({ text: z.string().trim().min(1).max(2000) });

const dto = (m: AgentMessage): AgentMessageDTO => ({ id: m.id, from: m.from, text: m.text, jobId: m.jobId, createdAt: m.createdAt.toISOString() });

// An installation's in-app message box, for its owner only.
export async function GET(req: Request, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const rt = serverRuntime();
  const loaded = await ownedInstallation(rt, user.id, params.id);
  if (!loaded) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ messages: (await messagesOf(rt, loaded.installation.id)).map(dto) });
}

// A message to the agent: it starts a job with the message as its input.
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const shut = notLetIn(user);
  if (shut) return shut;
  const rt = serverRuntime();
  const loaded = await ownedInstallation(rt, user.id, params.id);
  if (!loaded) return Response.json({ error: "Not found" }, { status: 404 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Write a message of up to 2000 characters." }, { status: 400 });
  try {
    const message = await sendToAgent(rt, loaded.installation, loaded.definition, parsed.data.text);
    return Response.json({ message: dto(message) }, { status: 201 });
  } catch (err) {
    if (err instanceof MessageRefused) return Response.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
