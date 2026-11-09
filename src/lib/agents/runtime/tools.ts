import "server-only";
import { fixDashes } from "../../dashes";
import { eq, sql } from "drizzle-orm";
import { agentFetchDays, agentInstallations, agentMessages, agentToolDays, users, type AgentInstallation, type AgentJob, type SheetGrant, type User } from "../../db/schema";
import { GoogleRevoked, GoogleUnavailable, REVOKED_REASON } from "../../google/oauth";
import { readTab, SheetRefused, writeTab, type SheetRow } from "../../google/sheets";
import { braveSearch, SearchRefused, SearchUnavailable } from "../../search/brave";
import type { AgentDefinition, AgentStep, ToolName } from "../definition";
import { Blocked, Declined, Halted, InfraError, Paused, type CallContext, type ToolHost } from "../runner";
import { askGuard, GUARD_DOWN, guardKey, type GuardInput, type GuardResult } from "../guard";
import type { Risk } from "../toolbox";
import { unknownContacts } from "../untrusted";
import { MAX_MEMORY_BYTES, memoryProblem, MockTools, TOOL_ARGS, ToolError } from "../toolbox";
import { emptyBench } from "../types";
import type { Runtime } from "./context";
import { overLimit, recordSpend, spendOf } from "./spend";
import { policyAsks, readPolicy, riskOf, TO_OWNER_ONLY } from "../risk";
import { describeCall } from "../calls";
import { fetchPage, WebUnreachable } from "./webFetch";

// A job's tools (and a value check's, with no job). Sheets are real: the
// owner's own Google Sheets, only the tabs they gave this installation,
// within a number of calls a day. So is web search (Brave), within a number
// of searches a day for each installation and for the whole site; what it
// finds is untrusted, like a fetched page. The one still a stand-in (the
// wallet) answers like the test bench's mock, from the installation's own
// copy of the bench's data, and what it changes is kept on the
// installation for its next job. A message to
// the owner (telegram.send) goes to the installation's in-app message box
// and to the owner's linked Telegram chat, and nowhere else.
// Memory is real: what the agent remembers for this owner, on their
// installation alone. So is web.fetch (webFetch.ts), within a number of
// pages a day for each installation.

// The whole site's daily counts are kept under the nil id.
const SITE = "00000000-0000-0000-0000-000000000000";

export const isYes = (answer: string | null) => answer !== null && /^\s*(yes|y|ok|okay|approve|approved|go ahead)\b/i.test(answer);

export class JobTools implements ToolHost {
  private mock: MockTools | null = null;
  // The guard's answers in this run, by call: the same call is checked once.
  private checked = new Map<string, GuardResult>();

  constructor(
    private rt: Runtime,
    private installation: AgentInstallation,
    private definition: AgentDefinition,
    private job: AgentJob | null,
    private owner: User | null = null,
  ) {}

  // What the renter gave it themselves: their answers, rules and, for a job
  // they started with a message, that message.
  private known(): string {
    const trigger = this.job?.trigger as { kind?: string; text?: string } | undefined;
    return JSON.stringify([this.installation.settings, this.installation.rules, trigger?.kind === "message" ? trigger.text ?? "" : ""]);
  }

  private async ownerOf(): Promise<User> {
    if (this.owner) return this.owner;
    const [u] = await this.rt.db.select().from(users).where(eq(users.id, this.installation.ownerUserId));
    this.owner = u!;
    return u!;
  }

  // SERV's check of a call that writes, sends or spends: once per call in a
  // run. When SERV can't be reached, can't be paid for today or doesn't
  // answer, the answer is ask, never allow.
  private async guard(step: AgentStep, tool: ToolName, risk: Risk, args: unknown, ctx: CallContext | undefined): Promise<GuardResult> {
    const key = guardKey(tool, args);
    const seen = this.checked.get(key);
    if (seen) return seen;
    const owner = await this.ownerOf();
    const input: GuardInput = {
      definition: this.definition,
      step,
      tool,
      risk,
      args,
      settings: settingsByLabel(this.definition, this.installation),
      inputs: ctx?.inputs ?? {},
      untrusted: ctx?.untrusted ?? [],
    };
    let result: GuardResult;
    if (this.rt.guard) {
      result = { ...(await this.rt.guard(input)), fallback: false, call: null };
    } else {
      const serv = this.rt.serv(owner);
      const refused = serv ? await this.rt.siteRefusal(owner, serv.ownKey) : null;
      if (!serv || refused) result = { verdict: "ask", reason: GUARD_DOWN, fallback: true, call: null };
      else {
        result = await askGuard(input, serv.config, { fetchImpl: this.rt.fetchImpl });
        await this.rt.record(owner, result.call!, serv.ownKey, "agent_guard");
      }
    }
    this.checked.set(key, result);
    return result;
  }

  // The installation's stand-in data, read fresh when a job (re)starts.
  private async mocks(): Promise<MockTools> {
    if (this.mock) return this.mock;
    const [row] = await this.rt.db.select({ mocks: agentInstallations.mocks, memory: agentInstallations.memory }).from(agentInstallations).where(eq(agentInstallations.id, this.installation.id));
    this.mock = new MockTools({ ...emptyBench(), ...row!.mocks, memory: row!.memory });
    return this.mock;
  }

  async call(step: AgentStep, tool: ToolName, args: unknown, approval?: { answer: string | null }, ctx?: CallContext): Promise<unknown> {
    if (tool === "telegram.ask") {
      const parsed = TOOL_ARGS["telegram.ask"].safeParse(args);
      if (!parsed.success) throw new ToolError(tool, "telegram.ask was called wrongly: it takes { question, choices? }.");
      // A question goes only to the renter, who answers it: the guard can
      // stop one that shouldn't be asked, and asking is what it does.
      const strange = unknownContacts(args, this.known());
      if (!approval) {
        const g = await this.guard(step, tool, "outbound", args, ctx);
        if (g.verdict === "block") throw new Blocked(g.reason);
      }
      // The owner's answer, once it has come; until then the job waits.
      if (!approval) {
        throw new Paused({
          kind: "ask",
          question: fixDashes(parsed.data.question),
          choices: parsed.data.choices?.length ? parsed.data.choices : ["Yes", "No"],
          reason: strange.length ? `It mentions ${strange.length === 1 ? "something" : "things"} you didn't give it: ${strange.slice(0, 3).join(", ")}. Don't follow ${strange.length === 1 ? "it" : "them"} unless you trust ${strange.length === 1 ? "it" : "them"}.` : null,
        });
      }
      if (approval.answer === null) throw new Declined(null);
      return { answer: approval.answer };
    }
    const risk = riskOf(this.definition, step, tool);
    if (risk === "read") return this.use(step, tool, args);
    // Anything that changes, says or spends something waits for the
    // renter's yes when the platform's floor or their own settings say so,
    // or when spending would take the job's or the day's total over a
    // rule's limit (spend.ts). One answer covers them all; a no stops it.
    const spend = spendOf(this.definition, step, tool, args);
    if (approval) {
      if (!isYes(approval.answer)) throw new Declined(approval.answer);
    } else {
      const over = spend ? await overLimit(this.rt, this.installation, this.definition, this.job?.id ?? null, spend) : null;
      const why = policyAsks(readPolicy(this.installation.policy), { tool, risk, amount: spend?.amount ?? 0, toOwner: TO_OWNER_ONLY.includes(tool) });
      if (risk === "outbound" || risk === "money") {
        const strange = unknownContacts(args, this.known());
        if (strange.length) why.push(`It carries ${strange.length === 1 ? "a link, address or contact detail" : "links, addresses or contact details"} you didn't give it: ${strange.slice(0, 3).join(", ")}.`);
      }
      const g = await this.guard(step, tool, risk, args, ctx);
      if (g.verdict === "block") throw new Blocked(g.reason);
      if (g.verdict === "ask") why.push(g.fallback ? g.reason : `Safety check: ${g.reason}`);
      if (over || why.length) {
        throw new Paused({ kind: why.length ? "safety" : "over_limit", question: over ?? spend?.what ?? describeCall(tool, args), choices: ["Yes", "No"], tool, reason: why.join(" ") || null });
      }
    }
    const result = await this.use(step, tool, args);
    if (spend) await recordSpend(this.rt, this.installation, this.job?.id ?? null, spend);
    return result;
  }

  private async use(step: AgentStep, tool: ToolName, args: unknown): Promise<unknown> {
    if (tool === "sheets.read" || tool === "sheets.write") return this.sheet(tool, args);
    if (tool === "memory.get" || tool === "memory.set") return this.memory(tool, args);
    if (tool === "web.fetch") return this.fetch(args);
    if (tool === "web.search") return this.search(args);
    if (tool === "telegram.send") {
      const parsed = TOOL_ARGS["telegram.send"].safeParse(args);
      if (!parsed.success) throw new ToolError(tool, "telegram.send was called wrongly: it takes { text }.");
      // To the owner's message box, and their linked Telegram chat: the
      // only place it can go (telegram/deliver.ts).
      // Words people read carry no em dashes, as in chat.
      await this.rt.db.insert(agentMessages).values({ installationId: this.installation.id, from: "agent", text: fixDashes(parsed.data.text), jobId: this.job?.id ?? null, tgState: "pending", createdAt: this.rt.now() });
      return { sent: true };
    }
    const mock = await this.mocks();
    const result = await mock.call(tool, args);
    if (tool === "wallet.pay") {
      await this.rt.db
        .update(agentInstallations)
        .set({ mocks: mock.kept, updatedAt: this.rt.now() })
        .where(eq(agentInstallations.id, this.installation.id));
    }
    return result;
  }

  // One more call of a kind today, within its limit: false when the limit
  // is reached. The site's own total is kept under the nil id.
  private async take(tool: string, limit: number, id = this.installation.id): Promise<boolean> {
    const day = this.rt.now().toISOString().slice(0, 10);
    const taken = await this.rt.db
      .insert(agentToolDays)
      .values({ installationId: id, day, tool, calls: 1 })
      .onConflictDoUpdate({ target: [agentToolDays.installationId, agentToolDays.day, agentToolDays.tool], set: { calls: sql`${agentToolDays.calls} + 1` }, setWhere: sql`${agentToolDays.calls} < ${limit}` })
      .returning({ calls: agentToolDays.calls });
    return taken.length > 0;
  }

  // The tab a sheet tool names: by its name (the value of a sheet setting)
  // or by the setting itself. Only the tabs the owner gave this
  // installation; any other name is refused, whatever the code passes.
  private grant(name: string): SheetGrant {
    const grants = Object.entries((this.installation.sheets ?? {}) as Record<string, SheetGrant>);
    const byKey = grants.find(([k]) => k === name)?.[1];
    if (byKey) return byKey;
    const byTab = grants.filter(([, g]) => g.tab === name).map(([, g]) => g);
    if (byTab.length && byTab.every((g) => g.spreadsheetId === byTab[0]!.spreadsheetId)) return byTab[0]!;
    const given = [...new Set(grants.map(([, g]) => `"${g.tab}"`))];
    throw new ToolError("sheets", given.length ? `This agent wasn't given a sheet called "${name}". It was given ${given.join(", ")}.` : "This agent wasn't given any sheets.");
  }

  private async sheet(tool: "sheets.read" | "sheets.write", args: unknown): Promise<unknown> {
    const parsed = TOOL_ARGS[tool].safeParse(args);
    if (!parsed.success) throw new ToolError(tool, tool === "sheets.read" ? "sheets.read was called wrongly: it takes { sheet }." : "sheets.write was called wrongly: it takes { sheet, rows, mode? }.");
    const g = this.grant(parsed.data.sheet);
    const limit = this.rt.services.caps.sheetCalls;
    if (!(await this.take("sheets", limit))) throw new ToolError(tool, `It reached its limit of ${limit} sheet calls today.`);
    try {
      if (tool === "sheets.read") return { rows: await readTab(this.rt, this.installation.ownerUserId, g) };
      const w = parsed.data as unknown as { rows: SheetRow[]; mode?: "append" | "replace" };
      return { written: await writeTab(this.rt, this.installation.ownerUserId, g, w.rows, w.mode ?? "append") };
    } catch (err) {
      if (err instanceof GoogleRevoked) throw new Halted(REVOKED_REASON);
      if (err instanceof GoogleUnavailable) throw new InfraError(err.message);
      if (err instanceof SheetRefused) throw new ToolError(tool, err.message);
      throw err;
    }
  }

  // A real web search, within the installation's searches a day and the
  // site's. Brave being busy is worth another try; refusing isn't.
  private async search(args: unknown): Promise<unknown> {
    const parsed = TOOL_ARGS["web.search"].safeParse(args);
    if (!parsed.success) throw new ToolError("web.search", "web.search was called wrongly: it takes { query }.");
    if (!this.rt.services.braveKey) throw new ToolError("web.search", "Web search isn't set up here.");
    const { searches, siteSearches } = this.rt.services.caps;
    if (!(await this.take("search", searches))) throw new ToolError("web.search", `It reached its limit of ${searches} searches today.`);
    if (!(await this.take("search", siteSearches, SITE))) throw new ToolError("web.search", "boardofserv's web searches for today are used up. It can search again tomorrow.");
    try {
      return { results: await braveSearch(this.rt.services, parsed.data.query) };
    } catch (err) {
      if (err instanceof SearchUnavailable) throw new InfraError(err.message);
      if (err instanceof SearchRefused) {
        this.rt.log(`search: refused: ${err.message}`);
        throw new ToolError("web.search", err.message);
      }
      throw err;
    }
  }

  // A real page, within the installation's pages a day. A page that can't
  // be reached is worth another try later; one the agent may not have isn't.
  private async fetch(args: unknown): Promise<unknown> {
    const parsed = TOOL_ARGS["web.fetch"].safeParse(args);
    if (!parsed.success) throw new ToolError("web.fetch", "web.fetch was called wrongly: it takes { url }, a full http or https address.");
    const day = this.rt.now().toISOString().slice(0, 10);
    const limit = this.rt.fetchesPerDay;
    const taken = await this.rt.db
      .insert(agentFetchDays)
      .values({ installationId: this.installation.id, day, fetches: 1 })
      .onConflictDoUpdate({ target: [agentFetchDays.installationId, agentFetchDays.day], set: { fetches: sql`${agentFetchDays.fetches} + 1` }, setWhere: sql`${agentFetchDays.fetches} < ${limit}` })
      .returning({ fetches: agentFetchDays.fetches });
    if (!taken.length) throw new ToolError("web.fetch", `It reached its limit of ${limit} pages today.`);
    try {
      return await fetchPage(parsed.data.url, this.rt.web);
    } catch (err) {
      if (err instanceof WebUnreachable) throw new InfraError(err.message);
      throw new ToolError("web.fetch", err instanceof Error ? err.message : "The page couldn't be fetched.");
    }
  }

  // What the agent remembers for this owner: on this installation's row
  // only, never another's, and only the fields the agent declares, each
  // holding its type. Written at once, one field at a time.
  private async memory(tool: "memory.get" | "memory.set", args: unknown): Promise<unknown> {
    const parsed = TOOL_ARGS[tool].safeParse(args);
    if (!parsed.success) throw new ToolError(tool, `${tool} was called wrongly: it takes ${tool === "memory.get" ? "{ key }" : "{ key, value }"}.`);
    const { key } = parsed.data;
    const value = tool === "memory.set" ? ((parsed.data as { value?: unknown }).value ?? null) : null;
    const why = memoryProblem(this.definition.memory, key, value);
    if (why) throw new ToolError(tool, why);
    const here = eq(agentInstallations.id, this.installation.id);
    if (tool === "memory.get") {
      const [row] = await this.rt.db.select({ value: sql<unknown>`${agentInstallations.memory} -> ${key}` }).from(agentInstallations).where(here);
      return { value: row?.value ?? null };
    }
    const [row] = await this.rt.db.select({ size: sql<number>`length((${agentInstallations.memory} - ${key})::text)` }).from(agentInstallations).where(here);
    if ((row?.size ?? 0) + JSON.stringify(value).length > MAX_MEMORY_BYTES) throw new ToolError(tool, `It can't remember more than ${MAX_MEMORY_BYTES / 1000} KB in all.`);
    await this.rt.db
      .update(agentInstallations)
      .set({ memory: sql`${agentInstallations.memory} || jsonb_build_object(${key}::text, ${JSON.stringify(value)}::jsonb)`, updatedAt: this.rt.now() })
      .where(here);
    return { ok: true };
  }
}

// The renter's answers and rules, by their labels, for the guard to read.
export function settingsByLabel(d: AgentDefinition, i: Pick<AgentInstallation, "settings" | "rules">): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const s of d.settings) out[s.label] = i.settings[s.key] ?? null;
  for (const r of d.rules) out[r.label] = i.rules[r.key] ?? r.value;
  return out;
}
