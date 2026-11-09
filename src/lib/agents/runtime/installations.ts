import "server-only";
import { and, desc, eq, inArray } from "drizzle-orm";
import { agentApprovals, agentInstallations, agentJobs, agents, agentTriggers, agentVersions, rentals, type Agent, type AgentInstallation, type AgentVersion, type SheetGrant } from "../../db/schema";
import { GoogleRevoked, GoogleUnavailable } from "../../google/oauth";
import { isSheetAnswer, parseSheetLink, sheetLink } from "../../google/sheetLink";
import { SheetRefused, sheetInfo } from "../../google/sheets";
import type { InstallationDTO } from "../../types";
import { hasConnection, SERVICE_NAME } from "../../connections/vault";
import { connectionsNeeded, type AgentDefinition } from "../definition";
import { describeTriggers } from "../schedule";
import { checkAnswers, type InstallAnswers } from "../settingsForm";
import { emptyBench } from "../types";
import { readPolicy, safetyOf, type SafetyPolicy } from "../risk";
import { budgetConfig, budgetDTO } from "../metering";
import type { Runtime } from "./context";
import { approvalsOf } from "./approvals";
import { enqueue } from "./jobs";
import { setUpTriggers } from "./triggers";
import { jobRoom, rateLimits } from "./rates";
import { jobsOfInstallation, spendToday } from "./views";

// Installations: one owner's running copy of a published agent version.
// Anyone can be an owner: for now a maker installs their own agent from the
// test bench, and renting (a later phase) installs for someone else through
// the same install().

export class InstallRefused extends Error {
  constructor(
    message: string,
    readonly errors: Record<string, string> = {},
  ) {
    super(message);
    this.name = "InstallRefused";
  }
}

// Why this version can't run yet, or null.
export function notRunnable(version: AgentVersion): string | null {
  if (version.state !== "published") return "Publish a version first: an installation runs a published version, which never changes.";
  const d = version.definition;
  if (!d) return "Plan it first.";
  const unwritten = d.steps.filter((s) => s.kind === "code" && version.code[s.id]?.status !== "approved");
  if (unwritten.length) return `Every code step needs approved code first ("${unwritten[0]!.title}" doesn't have it).`;
  return null;
}

// live: false sets it up for a test run first (not live): nothing starts
// it but its owner's test runs, until they make it live.
// policy: what the renter lets it do on its own (agents/risk.ts); none
// means the platform's floor alone.
export async function install(rt: Runtime, o: { ownerUserId: string; agent: Agent; version: AgentVersion; answers: InstallAnswers; live?: boolean; policy?: Partial<SafetyPolicy> }): Promise<AgentInstallation> {
  const why = notRunnable(o.version);
  if (why) throw new InstallRefused(why);
  const d = o.version.definition!;
  const missing = await missingConnections(rt, o.ownerUserId, d);
  if (missing.length) throw new InstallRefused(`${missing.map((p) => (p === "telegram" ? "Link Telegram" : "Connect Google")).join(" and ")} first, on Connections: this agent needs ${missing.length > 1 ? "them" : "it"}.`);
  const checked = checkAnswers(d, o.answers);
  if (!checked.ok) throw new InstallRefused("Some answers need another look.", checked.errors);
  const { settings, sheets } = await grantSheets(rt, o.ownerUserId, d, checked.settings);
  const bench = o.version.bench ?? emptyBench();
  const now = rt.now();
  const [row] = await rt.db
    .insert(agentInstallations)
    .values({
      agentId: o.agent.id,
      versionId: o.version.id,
      ownerUserId: o.ownerUserId,
      live: o.live !== false,
      settings,
      sheets,
      rules: checked.rules,
      mocks: { sheets: bench.sheets, search: bench.search, wallet: bench.wallet },
      timezone: checked.timezone,
      schedule: checked.schedule,
      minGapMinutes: checked.minGapMinutes,
      dailySpendUsd: String(checked.dailySpendUsd),
      policy: readPolicy({ ...o.policy, autoSpendUsdc: o.policy?.autoSpendUsdc ?? o.answers.autoSpendUsdc }),
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (row!.live) await setUpTriggers(rt, row!, d);
  return row!;
}

// The sheets an owner gives an installation: each sheet setting's link
// opened on the owner's own Google access (so it is one they may open),
// its tab found, and kept as a grant. Code sees the tab's name; the sheet
// tools reach only the tabs granted here.
export async function grantSheets(rt: Runtime, ownerUserId: string, d: AgentDefinition, answers: Record<string, unknown>): Promise<{ settings: Record<string, unknown>; sheets: Record<string, SheetGrant> }> {
  const settings = { ...answers };
  const sheets: Record<string, SheetGrant> = {};
  const asked = d.settings.filter((s) => s.type === "sheet");
  if (!asked.length) return { settings, sheets };
  if (!(await hasConnection(rt, ownerUserId, "google"))) throw new InstallRefused("Connect Google first, on Connections: this agent works on your Google Sheets.");
  const errors: Record<string, string> = {};
  const seen = new Map<string, string>();
  for (const s of asked) {
    const v = answers[s.key];
    const link = isSheetAnswer(v) ? parseSheetLink(v.url) : null;
    if (!isSheetAnswer(v) || !link) {
      errors[s.key] = "Paste the link of a Google Sheet, then pick its tab.";
      continue;
    }
    try {
      const info = await sheetInfo(rt, ownerUserId, link.spreadsheetId);
      const tab = info.tabs.find((t) => t.title === v.tab);
      if (!tab) {
        errors[s.key] = `"${info.title}" has no tab called "${v.tab}". Pick one of its tabs.`;
        continue;
      }
      // Code names a tab by its name: two tabs of one name in different
      // spreadsheets couldn't be told apart.
      const other = seen.get(tab.title);
      if (other && other !== link.spreadsheetId) {
        errors[s.key] = `Another sheet here has a tab called "${tab.title}" too. Rename one of the tabs, then try again.`;
        continue;
      }
      seen.set(tab.title, link.spreadsheetId);
      sheets[s.key] = { spreadsheetId: link.spreadsheetId, title: info.title, tab: tab.title, tabId: tab.id };
      settings[s.key] = tab.title;
    } catch (err) {
      if (err instanceof SheetRefused) errors[s.key] = err.message;
      else if (err instanceof GoogleRevoked) throw new InstallRefused("Google stopped letting boardofserv in. Connect Google again on Connections, then try again.");
      else if (err instanceof GoogleUnavailable) throw new InstallRefused("Google couldn't be reached just now. Try again in a minute.");
      else throw err;
    }
  }
  if (Object.keys(errors).length) throw new InstallRefused("Some answers need another look.", errors);
  return { settings, sheets };
}

// An installation with its agent and version, for its owner only: null for
// anyone else, as if it weren't there.
export async function ownedInstallation(rt: Runtime, ownerUserId: string, id: string): Promise<Loaded | null> {
  const loaded = await loadInstallation(rt, id);
  return loaded && loaded.installation.ownerUserId === ownerUserId ? loaded : null;
}

export interface Loaded {
  installation: AgentInstallation;
  agent: Agent;
  version: AgentVersion;
  definition: AgentDefinition;
}

export async function loadInstallation(rt: Runtime, id: string): Promise<Loaded | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await rt.db
    .select({ installation: agentInstallations, agent: agents, version: agentVersions })
    .from(agentInstallations)
    .innerJoin(agents, eq(agents.id, agentInstallations.agentId))
    .innerJoin(agentVersions, eq(agentVersions.id, agentInstallations.versionId))
    .where(eq(agentInstallations.id, id))
    .limit(1);
  if (!row?.version.definition) return null;
  return { ...row, definition: row.version.definition };
}

export async function installationsOf(rt: Runtime, ownerUserId: string): Promise<Loaded[]> {
  const rows = await rt.db
    .select({ installation: agentInstallations, agent: agents, version: agentVersions })
    .from(agentInstallations)
    .innerJoin(agents, eq(agents.id, agentInstallations.agentId))
    .innerJoin(agentVersions, eq(agentVersions.id, agentInstallations.versionId))
    .where(and(eq(agentInstallations.ownerUserId, ownerUserId)))
    .orderBy(desc(agentInstallations.createdAt))
    .limit(100);
  return rows.flatMap((r) => (r.version.definition ? [{ ...r, definition: r.version.definition }] : []));
}

// What its owner sees of an installation.
export async function installationDTO(rt: Runtime, l: Loaded): Promise<InstallationDTO> {
  const { installation: i, definition: d } = l;
  const triggers = await rt.db.select().from(agentTriggers).where(eq(agentTriggers.installationId, i.id));
  const next = triggers.filter((t) => t.kind === "schedule" || t.kind === "check").map((t) => t.nextAt.getTime());
  const failing = triggers.find((t) => t.note);
  return {
    id: i.id,
    agentId: l.agent.id,
    name: d.name,
    version: l.version.number,
    // Set up but not live yet reads as testing.
    status: i.status === "active" && !i.live ? "testing" : i.status,
    pausedReason: i.status === "paused" ? i.pausedReason : null,
    needs: connectionsNeeded(d),
    missing: await missingConnections(rt, i.ownerUserId, d),
    timezone: i.timezone,
    settings: d.settings.map((s) => {
      const g = (i.sheets as Record<string, SheetGrant>)[s.key];
      return { key: s.key, label: s.label, value: i.settings[s.key] ?? null, ...(g ? { sheet: { title: g.title, tab: g.tab, link: sheetLink(g.spreadsheetId, g.tabId) } } : {}) };
    }),
    rules: d.rules.map((r) => ({ key: r.key, label: r.label, type: r.type, value: i.rules[r.key] ?? r.value })),
    minGapMinutes: i.minGapMinutes,
    dailySpendUsd: Number(i.dailySpendUsd),
    createdAt: i.createdAt.toISOString(),
    runs: describeTriggers(d, i.schedule),
    nextRunAt: i.status === "active" && i.live && next.length ? new Date(Math.min(...next)).toISOString() : null,
    takesMessages: d.triggers.some((t) => t.kind === "message"),
    checkNote: failing?.note ?? null,
    memory: d.memory.map((m) => ({ key: m.key, description: m.description, value: i.memory[m.key] ?? null })),
    spendTodayUsd: await spendToday(rt, i.id),
    recentJobs: await jobsOfInstallation(rt, i.id, 5),
    approvals: await approvalsOf(rt, i.ownerUserId, { installationId: i.id, pendingOnly: true }),
    safety: safetyOf(d, readPolicy(i.policy)),
    budget: await budgetDTO(rt, i),
  };
}

// The renter's weekly model budget, within the platform's ceiling (none
// goes back to the maker's default).
export async function setModelBudget(rt: Runtime, l: Loaded, budget: bigint | null): Promise<void> {
  const ceiling = budgetConfig().ceiling;
  const value = budget === null ? null : (budget > ceiling ? ceiling : budget < 0n ? 0n : budget).toString();
  await rt.db.update(agentInstallations).set({ modelBudget: value, updatedAt: rt.now() }).where(eq(agentInstallations.id, l.installation.id));
}

// The renter raises what asks first (never below the platform's floor:
// readPolicy keeps reads out and the auto limit in bounds).
export async function setPolicy(rt: Runtime, l: Loaded, policy: SafetyPolicy): Promise<void> {
  const allowed = new Set(safetyOf(l.definition, policy).tools.filter((t) => t.canRaise).map((t) => t.tool));
  const askFor = policy.askFor.filter((t) => allowed.has(t));
  await rt.db
    .update(agentInstallations)
    .set({ policy: readPolicy({ askFor, autoSpendUsdc: policy.autoSpendUsdc }), updatedAt: rt.now() })
    .where(eq(agentInstallations.id, l.installation.id));
}

// The connections this agent needs that its owner hasn't made.
export async function missingConnections(rt: Runtime, ownerUserId: string, d: AgentDefinition): Promise<("telegram" | "google")[]> {
  const needs = connectionsNeeded(d);
  const missing: ("telegram" | "google")[] = [];
  for (const p of ["telegram", "google"] as const) if (needs[p] && !(await hasConnection(rt, ownerUserId, p))) missing.push(p);
  return missing;
}

export type Control = "pause" | "resume" | "stop" | "run" | "test" | "golive";

export class ControlRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlRefused";
  }
}

// The owner's controls.
// - pause: nothing new starts (no trigger fires, queued jobs wait); a job
//   running now finishes.
// - resume: schedules pick up from now, value checks check again.
// - stop, for good: queued jobs are cancelled, a job waiting for an answer
//   is cancelled with its question, and a running job finishes the step
//   it is on and stops there.
// - run: one job now, by hand (it still keeps the minimum gap).
// - test: while it is being set up, one job now, by hand: everything for
//   real, once, before it goes live.
// - golive: from being set up to running on its own (its triggers start).
export async function control(rt: Runtime, l: Loaded, action: Control): Promise<void> {
  const { installation: i, definition: d } = l;
  const now = rt.now();
  const here = eq(agentInstallations.id, i.id);
  if (i.status === "stopped") throw new ControlRefused("It's stopped for good. Start it again from its agent's page.");
  if (!i.live && !["test", "golive", "stop", "resume"].includes(action)) throw new ControlRefused("It isn't live yet: run a test, then make it live.");
  if (action === "test" || action === "golive") {
    if (i.live) throw new ControlRefused(action === "test" ? "It's live already: use Run now." : "It's live already.");
    if (i.status !== "active") throw new ControlRefused("Resume it first.");
  }
  if (action === "test") {
    const missing = await missingConnections(rt, i.ownerUserId, d);
    if (missing.length) throw new ControlRefused(`Connect ${missing.map((p) => SERVICE_NAME[p]).join(" and ")} first, on Connections: this agent needs ${missing.length > 1 ? "them" : "it"}.`);
    await enqueue(rt, i, { kind: "test" });
    return;
  }
  if (action === "golive") {
    const missing = await missingConnections(rt, i.ownerUserId, d);
    if (missing.length) throw new ControlRefused(`Connect ${missing.map((p) => SERVICE_NAME[p]).join(" and ")} first, on Connections: this agent needs ${missing.length > 1 ? "them" : "it"}.`);
    const [row] = await rt.db.update(agentInstallations).set({ live: true, updatedAt: now }).where(and(here, eq(agentInstallations.live, false))).returning();
    if (row) await setUpTriggers(rt, row, d);
    return;
  }
  if (action === "pause") {
    if (i.status !== "active") throw new ControlRefused("It's paused already.");
    await rt.db.update(agentInstallations).set({ status: "paused", pausedReason: null, updatedAt: now }).where(here);
    return;
  }
  if (action === "resume") {
    if (i.status !== "paused") throw new ControlRefused("It isn't paused.");
    // A rented one whose week went unpaid resumes from Rented, which pays it.
    const [unpaid] = await rt.db.select({ id: rentals.id }).from(rentals).where(and(eq(rentals.installationId, i.id), eq(rentals.status, "unpaid")));
    if (unpaid) throw new ControlRefused("This week's rent isn't paid. Top up your wallet, then resume it from Rented: that pays the week.");
    const missing = await missingConnections(rt, i.ownerUserId, d);
    if (missing.length) throw new ControlRefused(`Connect ${missing.map((p) => SERVICE_NAME[p]).join(" and ")} first, on Connections: this agent needs ${missing.length > 1 ? "them" : "it"}.`);
    const [row] = await rt.db.update(agentInstallations).set({ status: "active", pausedReason: null, updatedAt: now }).where(here).returning();
    if (row!.live) await setUpTriggers(rt, row!, d);
    return;
  }
  if (action === "run") {
    if (i.status !== "active") throw new ControlRefused("Resume it first.");
    const room = await jobRoom(rt, i.id);
    if (!room.ok) throw new ControlRefused(`It has started its limit of ${rateLimits().jobsPerHour} jobs this hour. Try again later.`);
    await enqueue(rt, i, { kind: "manual" });
    return;
  }
  await rt.db.transaction(async (tx) => {
    await tx.update(agentInstallations).set({ status: "stopped", stoppedAt: now, updatedAt: now }).where(here);
    await tx
      .update(agentJobs)
      .set({ status: "cancelled", reason: "Stopped by its owner before it finished.", claimedBy: null, finishedAt: now, updatedAt: now })
      .where(and(eq(agentJobs.installationId, i.id), inArray(agentJobs.status, ["queued", "waiting_for_owner"])));
    await tx.update(agentJobs).set({ stopAsked: true, updatedAt: now }).where(and(eq(agentJobs.installationId, i.id), eq(agentJobs.status, "running")));
    await tx.update(agentApprovals).set({ status: "cancelled" }).where(and(eq(agentApprovals.installationId, i.id), eq(agentApprovals.status, "pending")));
    await tx.delete(agentTriggers).where(eq(agentTriggers.installationId, i.id));
  });
}
