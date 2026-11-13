import "server-only";
import { and, count, eq, sql } from "drizzle-orm";
import { agentJobs, agentMessages, type AgentInstallation, type AgentMessage } from "../../db/schema";
import type { AgentDefinition } from "../definition";
import type { Runtime } from "./context";
import { enqueue, type JobTrigger } from "./jobs";
import { jobRoom, pauseFor } from "./rates";

// An installation's in-app message box (Telegram comes later). A message
// from the owner starts a job at once, with the message as the job's input;
// what the agent sends its owner (telegram.send) shows here too.

export const MAX_WAITING_MESSAGES = 5;

export class MessageRefused extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "MessageRefused";
  }
}

// A message from the owner: kept in the message box, and a job started
// with it as the input.
export async function sendToAgent(rt: Runtime, i: AgentInstallation, d: AgentDefinition, text: string): Promise<AgentMessage> {
  if (!d.triggers.some((t) => t.kind === "message")) throw new MessageRefused("This agent doesn't take messages.");
  if (i.status === "stopped") throw new MessageRefused("It's stopped, so it takes no more messages.", 409);
  const [waiting] = await rt.db
    .select({ n: count() })
    .from(agentJobs)
    .where(and(eq(agentJobs.installationId, i.id), eq(agentJobs.status, "queued"), sql`${agentJobs.trigger}->>'kind' = 'message'`));
  if ((waiting?.n ?? 0) >= MAX_WAITING_MESSAGES) throw new MessageRefused(`It has ${MAX_WAITING_MESSAGES} messages waiting already. Give it a moment.`, 429);
  const room = await jobRoom(rt, i.id);
  if (!room.ok) {
    await pauseFor(rt, i.id, room.reason);
    throw new MessageRefused(room.reason, 429);
  }
  const now = rt.now();
  const [message] = await rt.db.insert(agentMessages).values({ installationId: i.id, from: "owner", text, createdAt: now }).returning();
  const job = await enqueue(rt, i, { kind: "message", text, messageId: message!.id } as JobTrigger);
  await rt.db.update(agentMessages).set({ jobId: job.id }).where(eq(agentMessages.id, message!.id));
  return { ...message!, jobId: job.id };
}

// A message held for the owner's yes (held.ts) isn't in the box until it
// is sent.
export async function messagesOf(rt: Runtime, installationId: string, limit = 50): Promise<AgentMessage[]> {
  const rows = await rt.db
    .select()
    .from(agentMessages)
    .where(and(eq(agentMessages.installationId, installationId), sql`coalesce(${agentMessages.tgState}, '') <> 'held'`))
    .orderBy(sql`${agentMessages.createdAt} desc`)
    .limit(limit);
  return rows.reverse();
}
