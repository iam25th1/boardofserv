import "server-only";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { agentSketches, type AgentSketchRow } from "./db/schema";
import type { SketchDTO } from "./types";

// The stored agent sketch for a conversation.

function toDTO(row: AgentSketchRow): SketchDTO {
  const { name, kind, watches, when, how, tells, asking, live } = row;
  return { name, kind, watches, when, how, tells, asking, live };
}

export async function loadSketch(conversationId: string): Promise<SketchDTO | null> {
  const row = await db.query.agentSketches.findFirst({ where: eq(agentSketches.conversationId, conversationId) });
  return row ? toDTO(row) : null;
}

export async function saveSketch(conversationId: string, sketch: SketchDTO): Promise<void> {
  const { live: _live, ...fields } = sketch;
  // live is never written here: switching an agent on is not part of chat.
  await db
    .insert(agentSketches)
    .values({ conversationId, ...fields, updatedAt: new Date() })
    .onConflictDoUpdate({ target: agentSketches.conversationId, set: { ...fields, updatedAt: new Date() } });
}
