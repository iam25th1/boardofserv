import "server-only";
import { eq } from "drizzle-orm";
import { agentInstallations, agentMessages, type AgentInstallation, type AgentJob } from "../../db/schema";
import type { AgentDefinition, AgentStep, ToolName } from "../definition";
import { Declined, Paused, typedRules, type ToolHost } from "../runner";
import { MockTools, TOOL_ARGS, ToolError } from "../toolbox";
import { emptyBench } from "../types";
import type { Runtime } from "./context";

// A job's tools (and a value check's, with no job). The ones that are
// still stand-ins (sheets, search, the wallet) answer like the test bench's
// mocks, from the installation's own copy of the bench's data, and what
// they change is kept on the installation for its next job. A message to
// the owner (telegram.send) goes to the installation's in-app message box.

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
    if (tool === "telegram.send") {
      const parsed = TOOL_ARGS["telegram.send"].safeParse(args);
      if (!parsed.success) throw new ToolError(tool, "telegram.send was called wrongly: it takes { text }.");
      await this.rt.db.insert(agentMessages).values({ installationId: this.installation.id, from: "agent", text: parsed.data.text, jobId: this.job?.id ?? null, createdAt: this.rt.now() });
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
    if (tool === "memory.set") {
      await this.rt.db.update(agentInstallations).set({ memory: mock.memory, updatedAt: this.rt.now() }).where(eq(agentInstallations.id, this.installation.id));
    }
    return result;
  }
}
