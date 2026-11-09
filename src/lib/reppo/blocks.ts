import "server-only";
import { and, count, eq, gte, inArray, isNull } from "drizzle-orm";
import { agentInstallations, agentListings, agentMessages, agents, reppoEvals, type ReppoEval } from "../db/schema";
import type { Runtime } from "../agents/runtime/context";

// When Reppo routes a job to block: the job is flagged to its maker (their
// dashboard) and waits in the admin queue with Reppo's reason. When one
// version collects several blocks within a window, its listing goes on
// hold: off the board until an admin looks. Renters are told in plain
// words; their installations keep running, with their pause button, as
// before. Reppo's word alone never stops anything that runs.

type Env = Record<string, string | undefined>;
const whole = (raw: string | undefined, fallback: number, min: number) => {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isInteger(n) && n >= min ? n : fallback;
};

export function holdSettings(env: Env = process.env) {
  return {
    // Blocks on one version within the window that put its listing on hold.
    blocks: whole(env.REPPO_HOLD_BLOCKS, 3, 1),
    days: whole(env.REPPO_HOLD_DAYS, 7, 1),
  };
}

export const holdReason = (n: number) => `Reppo's quality checks advised against ${n} of its recent jobs, so it is off the board until an admin looks.`;
export const renterNote = (name: string) =>
  `${name} is off the board for now while an admin looks at it: Reppo's quality checks advised against several of its recent jobs. It keeps running for you as before, and you can pause it any time from its page.`;

// After a job's score comes back.
export async function onJobResult(rt: Runtime, row: ReppoEval, settings = holdSettings()): Promise<boolean> {
  if (row.kind !== "job" || row.route !== "block") return false;
  const [listing] = await rt.db.select().from(agentListings).where(eq(agentListings.agentId, row.agentId));
  if (!listing || !listing.listed || listing.screen !== "ok" || listing.versionId !== row.versionId) return false;
  const windowStart = new Date(rt.now().getTime() - settings.days * 86_400_000);
  const since = listing.qualityClearedAt && listing.qualityClearedAt > windowStart ? listing.qualityClearedAt : windowStart;
  const [blocks] = await rt.db
    .select({ n: count() })
    .from(reppoEvals)
    .where(and(eq(reppoEvals.versionId, row.versionId), eq(reppoEvals.kind, "job"), eq(reppoEvals.route, "block"), gte(reppoEvals.completedAt, since)));
  const n = blocks?.n ?? 0;
  if (n < settings.blocks) return false;
  const [held] = await rt.db
    .update(agentListings)
    .set({ screen: "held", screenReason: holdReason(n), updatedAt: rt.now() })
    .where(and(eq(agentListings.agentId, row.agentId), eq(agentListings.screen, "ok")))
    .returning({ agentId: agentListings.agentId });
  if (!held) return false;
  // Its renters hear why, and that nothing changes for them.
  const [a] = await rt.db.select({ name: agents.name }).from(agents).where(eq(agents.id, row.agentId));
  const installs = await rt.db
    .select({ id: agentInstallations.id })
    .from(agentInstallations)
    .where(and(eq(agentInstallations.agentId, row.agentId), inArray(agentInstallations.status, ["active", "paused"])));
  const now = rt.now();
  for (const i of installs) await rt.db.insert(agentMessages).values({ installationId: i.id, from: "agent", text: renterNote(a?.name ?? "This agent"), tgState: "pending", createdAt: now });
  rt.log(`reppo: a listing went on hold after ${n} blocks.`);
  return true;
}

// Blocks no admin has looked at yet, for an agent (its maker's flag).
export async function openBlocks(rt: Runtime, agentId: string): Promise<number> {
  const [row] = await rt.db
    .select({ n: count() })
    .from(reppoEvals)
    .where(and(eq(reppoEvals.agentId, agentId), eq(reppoEvals.kind, "job"), eq(reppoEvals.route, "block"), isNull(reppoEvals.reviewedAt)));
  return row?.n ?? 0;
}
