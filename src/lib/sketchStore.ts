import "server-only";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { agentSketches, type AgentSketchRow } from "./db/schema";
import { fieldsOf } from "./sketchFields";
import type { SketchDTO } from "./types";

// The stored agent sketch for a conversation.

function toDTO(row: AgentSketchRow): SketchDTO {
  const { name, kind, watches, when, how, tells, takes, does, gives, asking, live, kindChosen } = row;
  return { name, kind, watches, when, how, tells, takes, does, gives, asking, live, kindChosen };
}

export async function loadSketch(conversationId: string): Promise<SketchDTO | null> {
  const row = await db.query.agentSketches.findFirst({ where: eq(agentSketches.conversationId, conversationId) });
  return row ? toDTO(row) : null;
}

// The maker picks the kind on the dock. The question the plan asked goes when
// it isn't one the new kind has. Null when there is no sketch yet.
export async function chooseKind(conversationId: string, kind: NonNullable<SketchDTO["kind"]>): Promise<SketchDTO | null> {
  const row = await db.query.agentSketches.findFirst({ where: eq(agentSketches.conversationId, conversationId) });
  if (!row) return null;
  const asking = row.asking && fieldsOf(kind).includes(row.asking) ? row.asking : null;
  const [saved] = await db
    .update(agentSketches)
    .set({ kind, kindChosen: true, asking, updatedAt: new Date() })
    .where(eq(agentSketches.conversationId, conversationId))
    .returning();
  return saved ? toDTO(saved) : null;
}

export async function saveSketch(conversationId: string, sketch: SketchDTO): Promise<void> {
  const { live: _live, ...fields } = sketch;
  // live is never written here: switching an agent on is not part of chat.
  await db
    .insert(agentSketches)
    .values({ conversationId, ...fields, updatedAt: new Date() })
    .onConflictDoUpdate({ target: agentSketches.conversationId, set: { ...fields, updatedAt: new Date() } });
}
