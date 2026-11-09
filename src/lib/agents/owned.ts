import "server-only";
import { z } from "zod";
import { getUserFromRequest } from "../auth-route";
import type { Agent, User } from "../db/schema";
import { agentById } from "./store";

// The signed-in maker and their agent, or the response that turns the
// request away: 401 signed out, 404 for anyone but the agent's maker (the
// agent isn't there for them).
export async function ownedAgent(req: Request, id: string): Promise<{ user: User; agent: Agent } | { refused: Response }> {
  const user = await getUserFromRequest(req);
  if (!user) return { refused: Response.json({ error: "Not signed in" }, { status: 401 }) };
  const agent = z.string().uuid().safeParse(id).success ? await agentById(id) : null;
  if (!agent || agent.ownerUserId !== user.id) return { refused: Response.json({ error: "Not found" }, { status: 404 }) };
  return { user, agent };
}
