import "server-only";
import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { agentInstallations, agentJobs, agentJobSteps, agents, agentVersions, type AgentJob } from "../../db/schema";
import { dayStart } from "../../spend";
import type { JobDTO, JobStepDTO, JobSummaryDTO } from "../../types";
import type { AgentDefinition } from "../definition";
import { approvalsOf } from "./approvals";
import { jobWhy } from "../plainWords";
import type { Runtime } from "./context";

// What people see of jobs. The owner sees everything of theirs: each step's
// input, output, tool calls, notes and the answers they gave. The maker
// sees how their agent ran on someone else's installation (which steps,
// how long, which model, what it cost, how it ended) and nothing of the
// owner's data. Anyone else sees nothing.

export type Viewer = "owner" | "maker";

// An installation's model spend today (UTC), across all its jobs.
export async function spendToday(rt: Runtime, installationId: string): Promise<number> {
  const [row] = await rt.db
    .select({ usd: sql<string>`coalesce(sum(${agentJobSteps.costUsd}), 0)::text` })
    .from(agentJobSteps)
    .innerJoin(agentJobs, eq(agentJobs.id, agentJobSteps.jobId))
    .where(and(eq(agentJobs.installationId, installationId), gte(agentJobSteps.startedAt, dayStart(rt.now()))));
  return Number(row?.usd ?? 0);
}

const TRIGGER_WORDS: Record<string, string> = { schedule: "on its schedule", check: "when its check turned true", message: "by your message", manual: "by hand", test: "as a test run" };

function summary(job: AgentJob, d: AgentDefinition | null, viewer: Viewer, mine: boolean): JobSummaryDTO {
  const kind = String((job.trigger as { kind?: string }).kind ?? "manual");
  return {
    id: job.id,
    installationId: job.installationId,
    agentName: d?.name ?? "An agent",
    status: job.status,
    // A failure's reason can quote the owner's data: theirs alone.
    reason: viewer === "owner" ? job.reason : null,
    outcome: job.outcome ?? null,
    why: viewer === "owner" ? jobWhy(job) : null,
    started: TRIGGER_WORDS[kind] ?? "by hand",
    trigger: kind,
    createdAt: job.createdAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
    costUsd: Number(job.costUsd),
    ms: job.state?.ms ?? 0,
    stepCount: job.state?.steps ?? 0,
    mine,
  };
}

// A job and every step it ran, as this viewer may see it, or null for
// anyone who may not see it at all.
export async function jobFor(rt: Runtime, userId: string, id: string): Promise<JobDTO | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await rt.db
    .select({ job: agentJobs, definition: agentVersions.definition, version: agentVersions.number, makerId: agents.ownerUserId })
    .from(agentJobs)
    .innerJoin(agentVersions, eq(agentVersions.id, agentJobs.versionId))
    .innerJoin(agents, eq(agents.id, agentVersions.agentId))
    .where(eq(agentJobs.id, id));
  if (!row) return null;
  const viewer: Viewer | null = row.job.ownerUserId === userId ? "owner" : row.makerId === userId ? "maker" : null;
  if (!viewer) return null;
  const d = row.definition;
  const steps = await rt.db.select().from(agentJobSteps).where(eq(agentJobSteps.jobId, id)).orderBy(asc(agentJobSteps.seq));
  const stepDTOs: JobStepDTO[] = steps.map((s) => {
    const def = d?.steps.find((x) => x.id === s.stepId);
    const base = {
      seq: s.seq,
      stepId: s.stepId,
      title: def?.title ?? s.stepId,
      kind: def?.kind ?? "code",
      status: s.status,
      ms: s.ms,
      model: s.model,
      costUsd: Number(s.costUsd),
      tools: s.tools.map((t) => ({ tool: t.tool, failed: t.error !== null })),
    };
    if (viewer === "maker") return base;
    return { ...base, input: s.input, output: s.output, outcome: s.outcome, note: s.note, calls: s.tools };
  });
  return {
    ...summary(row.job, d, viewer, viewer === "owner"),
    viewer,
    version: row.version,
    untrusted: viewer === "owner" ? (row.job.state?.untrusted ?? []) : [],
    steps: stepDTOs,
    plan: (d?.steps ?? []).map((s) => ({ id: s.id, title: s.title, kind: s.kind })),
    approvals: viewer === "owner" ? await approvalsOf(rt, userId, { jobId: id }) : [],
  };
}

// An installation's recent jobs, for its owner.
export async function jobsOfInstallation(rt: Runtime, installationId: string, limit = 10): Promise<JobSummaryDTO[]> {
  const rows = await rt.db
    .select({ job: agentJobs, definition: agentVersions.definition })
    .from(agentJobs)
    .innerJoin(agentVersions, eq(agentVersions.id, agentJobs.versionId))
    .where(eq(agentJobs.installationId, installationId))
    .orderBy(desc(agentJobs.createdAt))
    .limit(limit);
  return rows.map((r) => summary(r.job, r.definition, "owner", true));
}

// The maker's view of their agent's recent jobs, on every installation:
// their own in full, everyone else's without the owner's data.
export async function jobsOfAgent(rt: Runtime, makerId: string, agentId: string, limit = 30): Promise<JobSummaryDTO[]> {
  const installs = await rt.db.select({ id: agentInstallations.id }).from(agentInstallations).where(eq(agentInstallations.agentId, agentId));
  if (!installs.length) return [];
  const rows = await rt.db
    .select({ job: agentJobs, definition: agentVersions.definition })
    .from(agentJobs)
    .innerJoin(agentVersions, eq(agentVersions.id, agentJobs.versionId))
    .where(inArray(agentJobs.installationId, installs.map((i) => i.id)))
    .orderBy(desc(agentJobs.createdAt))
    .limit(limit);
  return rows.map((r) => {
    const mine = r.job.ownerUserId === makerId;
    return summary(r.job, r.definition, mine ? "owner" : "maker", mine);
  });
}
