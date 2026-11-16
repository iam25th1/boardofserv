import "server-only";
import { and, desc, eq, ne } from "drizzle-orm";
import { db } from "../db";
import { agentInstallations, agentVersions, type Agent, type AgentVersion } from "../db/schema";
import { setupDefaults, type AgentDefinition } from "./definition";
import type { AgentBuilderDTO } from "../types";
import { summaryOf } from "./build";
import { versionsOf } from "./store";
import { emptyBench } from "./types";
import { serverRuntime } from "./runtime/context";
import { makerListing } from "../market/listings";

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
    // Its setup starts from what the maker said and what runs now, never
    // from the sample its test made up.
    runnable: published?.definition ? { version: published.number, definition: published.definition, defaults: setupDefaults(published.definition, await runningFor(agent)) } : null,
    listing: await makerListing(serverRuntime(), agent.id),
    review: version.review ? { status: version.review.status, findings: version.review.findings, by: version.review.by, reviewedAt: version.review.reviewedAt } : null,
    heal: version.heal ?? null,
  };
}

// The maker's own copy running now, newest first: its version's questions
// and their answers.
async function runningFor(agent: Agent): Promise<{ definition: AgentDefinition; settings: Record<string, unknown> } | null> {
  const [row] = await db
    .select({ settings: agentInstallations.settings, definition: agentVersions.definition })
    .from(agentInstallations)
    .innerJoin(agentVersions, eq(agentVersions.id, agentInstallations.versionId))
    .where(and(eq(agentInstallations.agentId, agent.id), eq(agentInstallations.ownerUserId, agent.ownerUserId), ne(agentInstallations.status, "stopped")))
    .orderBy(desc(agentInstallations.createdAt))
    .limit(1);
  return row?.definition ? { definition: row.definition, settings: (row.settings ?? {}) as Record<string, unknown> } : null;
}
