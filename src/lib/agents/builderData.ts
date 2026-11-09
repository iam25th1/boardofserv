import "server-only";
import type { Agent, AgentVersion } from "../db/schema";
import type { AgentBuilderDTO } from "../types";
import { summaryOf } from "./build";
import { versionsOf } from "./store";
import { emptyBench } from "./types";

// The maker's builder: never sent to anyone else (the routes check).
export async function builderOf(agent: Agent, version: AgentVersion): Promise<AgentBuilderDTO> {
  const versions = await versionsOf(agent.id);
  const published = versions.find((v) => v.state === "published");
  return {
    agent: summaryOf(agent, version),
    name: version.definition?.name ?? agent.name,
    conversationId: agent.sourceConversationId,
    definition: version.definition,
    code: Object.fromEntries(Object.entries(version.code).map(([id, c]) => [id, { status: c.status, source: c.source, rounds: c.rounds, note: c.note, writer: c.writer ?? "dolphin" }])),
    bench: version.bench ?? emptyBench(),
    versions: versions.map((v) => ({ number: v.number, state: v.state, createdAt: v.createdAt.toISOString(), publishedAt: v.publishedAt?.toISOString() ?? null })),
    runnable: published?.definition ? { version: published.number, definition: published.definition, defaults: published.bench?.settings ?? {} } : null,
  };
}
