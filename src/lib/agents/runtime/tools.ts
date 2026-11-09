import "server-only";
import { eq, sql } from "drizzle-orm";
import { agentFetchDays, agentInstallations, agentMessages, type AgentInstallation, type AgentJob } from "../../db/schema";
import type { AgentDefinition, AgentStep, ToolName } from "../definition";
import { Declined, InfraError, Paused, typedRules, type ToolHost } from "../runner";
import { MAX_MEMORY_BYTES, memoryProblem, MockTools, TOOL_ARGS, ToolError } from "../toolbox";
import { emptyBench } from "../types";
import type { Runtime } from "./context";
import { fetchPage, WebUnreachable } from "./webFetch";

// A job's tools (and a value check's, with no job). The ones that are
// still stand-ins (sheets, search, the wallet) answer like the test bench's
// mocks, from the installation's own copy of the bench's data, and what
// they change is kept on the installation for its next job. A message to
// the owner (telegram.send) goes to the installation's in-app message box
// and to the owner's linked Telegram chat, and nowhere else.
// Memory is real: what the agent remembers for this owner, on their
// installation alone. So is web.fetch (webFetch.ts), within a number of
// pages a day for each installation.

export const isYes = (answer: string | null) => answer !== null && /^\s*(yes|y|ok|okay|approve|approved|go ahead)\b/i.test(answer);

export class JobTools implements ToolHost {
  private mock: MockTools | null = null;

  constructor(
    private rt: Runtime,
    private installation: AgentInstallation,
    private definition: AgentDefinition,
    private job: AgentJob | null,
  ) {}

  // The question for a payment over its action's limit, or null when it is
  // within it. The limit is the owner's value of the action's askOver rule.
  private overLimit(step: AgentStep, args: unknown): string | null {
    const d = this.definition;
    const action = step.kind === "action" ? d.actions.find((a) => a.id === step.action) : d.actions.find((a) => a.tool === "wallet.pay" && a.askOver);
    const rule = action?.askOver ? d.rules.find((r) => r.key === action.askOver) : undefined;
    const parsed = TOOL_ARGS["wallet.pay"].safeParse(args);
    if (!rule || !parsed.success) return null;
    const limit = typedRules(d, this.installation.rules)[rule.key];
    if (typeof limit !== "number" || parsed.data.amountUsdc <= limit) return null;
    return `Pay ${parsed.data.amountUsdc} USDC to ${parsed.data.to}${parsed.data.memo ? ` (${parsed.data.memo})` : ""}? That's over your limit of ${limit} USDC ("${rule.label}").`;
  }

  // The installation's stand-in data, read fresh when a job (re)starts.
  private async mocks(): Promise<MockTools> {
    if (this.mock) return this.mock;
    const [row] = await this.rt.db.select({ mocks: agentInstallations.mocks, memory: agentInstallations.memory }).from(agentInstallations).where(eq(agentInstallations.id, this.installation.id));
    this.mock = new MockTools({ ...emptyBench(), ...row!.mocks, memory: row!.memory });
    return this.mock;
  }

  async call(step: AgentStep, tool: ToolName, args: unknown, approval?: { answer: string | null }): Promise<unknown> {
    if (tool === "telegram.ask") {
      const parsed = TOOL_ARGS["telegram.ask"].safeParse(args);
      if (!parsed.success) throw new ToolError(tool, "telegram.ask was called wrongly: it takes { question, choices? }.");
      // The owner's answer, once it has come; until then the job waits.
      if (!approval) throw new Paused({ kind: "ask", question: parsed.data.question, choices: parsed.data.choices?.length ? parsed.data.choices : ["Yes", "No"] });
      if (approval.answer === null) throw new Declined(null);
      return { answer: approval.answer };
    }
    if (tool === "wallet.pay") {
      const over = this.overLimit(step, args);
      if (over && !approval) throw new Paused({ kind: "over_limit", question: over, choices: ["Yes", "No"] });
      if (over && !isYes(approval!.answer)) throw new Declined(approval!.answer);
    }
    if (tool === "memory.get" || tool === "memory.set") return this.memory(tool, args);
    if (tool === "web.fetch") return this.fetch(args);
    if (tool === "telegram.send") {
      const parsed = TOOL_ARGS["telegram.send"].safeParse(args);
      if (!parsed.success) throw new ToolError(tool, "telegram.send was called wrongly: it takes { text }.");
      // To the owner's message box, and their linked Telegram chat: the
      // only place it can go (telegram/deliver.ts).
      await this.rt.db.insert(agentMessages).values({ installationId: this.installation.id, from: "agent", text: parsed.data.text, jobId: this.job?.id ?? null, tgState: "pending", createdAt: this.rt.now() });
      return { sent: true };
    }
    const mock = await this.mocks();
    const result = await mock.call(tool, args);
    if (tool === "sheets.write" || tool === "wallet.pay") {
      await this.rt.db
        .update(agentInstallations)
        .set({ mocks: mock.kept, updatedAt: this.rt.now() })
        .where(eq(agentInstallations.id, this.installation.id));
    }
    return result;
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
