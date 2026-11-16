import "server-only";
import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { decryptSecret, encryptSecret, lookupHash } from "../../crypto";
import { agentInstallations, agentToolDays, agentVersions, type AgentInstallation } from "../../db/schema";
import type { AgentDefinition } from "../definition";
import { APP_URL, type Runtime } from "./context";
import { enqueue, type JobTrigger } from "./jobs";

// The catalog's Incoming webhook: an agent whose trigger is a post gets a
// private address of its own on its installation, shown to its owner
// alone. Each post to it starts a job, with what was posted as the
// trigger, which the run treats as untrusted (runner.ts). The address's
// key is kept encrypted, and found by a keyed hash, never stored readably.

export const MAX_HOOK_BODY = 20_000;
export const HOOK_POSTS_PER_DAY = 200;

export const takesPosts = (d: Pick<AgentDefinition, "triggers"> | null | undefined) => Boolean(d?.triggers.some((t) => t.kind === "webhook"));

const base = () => (process.env.APP_URL || APP_URL).replace(/\/+$/, "");

// Its private address, made the first time it is asked for; null for an
// agent that doesn't start on a post.
export async function hookUrl(rt: Runtime, i: AgentInstallation, d: AgentDefinition): Promise<string | null> {
  if (!takesPosts(d)) return null;
  if (i.hookSecret) {
    try {
      return `${base()}/api/hooks/${decryptSecret(i.hookSecret)}`;
    } catch {
      // The key changed: a new address.
    }
  }
  const key = randomBytes(24).toString("base64url");
  await rt.db
    .update(agentInstallations)
    .set({ hookSecret: encryptSecret(key), hookLookup: lookupHash("hook", key), updatedAt: rt.now() })
    .where(eq(agentInstallations.id, i.id));
  return `${base()}/api/hooks/${key}`;
}

export type Posted = { started: true; jobId: string } | { refused: { status: number; error: string } };

// A post to an address: the job it starts, or why none was started. An
// address nobody has is told apart from nothing.
export async function takePost(rt: Runtime, key: string, body: unknown): Promise<Posted> {
  const none = { refused: { status: 404, error: "There's no such address." } };
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(key)) return none;
  const [row] = await rt.db
    .select({ installation: agentInstallations, definition: agentVersions.definition })
    .from(agentInstallations)
    .innerJoin(agentVersions, eq(agentVersions.id, agentInstallations.versionId))
    .where(eq(agentInstallations.hookLookup, lookupHash("hook", key)));
  if (!row || !takesPosts(row.definition)) return none;
  const i = row.installation;
  if (i.status !== "active" || !i.live) return { refused: { status: 409, error: "This agent isn't running just now, so the post started nothing." } };
  const day = rt.now().toISOString().slice(0, 10);
  const taken = await rt.db
    .insert(agentToolDays)
    .values({ installationId: i.id, day, tool: "hook", calls: 1 })
    .onConflictDoUpdate({ target: [agentToolDays.installationId, agentToolDays.day, agentToolDays.tool], set: { calls: sql`${agentToolDays.calls} + 1` }, setWhere: and(sql`${agentToolDays.calls} < ${HOOK_POSTS_PER_DAY}`) })
    .returning({ calls: agentToolDays.calls });
  if (!taken.length) return { refused: { status: 429, error: `This agent took its ${HOOK_POSTS_PER_DAY} posts for today.` } };
  const job = await enqueue(rt, i, { kind: "webhook", body, at: rt.now().toISOString() } as JobTrigger);
  return { started: true, jobId: job.id };
}
