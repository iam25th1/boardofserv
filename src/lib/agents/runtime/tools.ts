import "server-only";
import { eq } from "drizzle-orm";
import { agentInstallations, agentMessages, type AgentInstallation, type AgentJob } from "../../db/schema";
import type { AgentDefinition, AgentStep, ToolName } from "../definition";
import type { ToolHost } from "../runner";
import { MockTools, TOOL_ARGS, ToolError } from "../toolbox";
import { emptyBench } from "../types";
import type { Runtime } from "./context";

// A job's tools (and a value check's, with no job). The ones that are
// still stand-ins (sheets, search, the wallet) answer like the test bench's
// mocks, from the installation's own copy of the bench's data, and what
// they change is kept on the installation for its next job. A message to
// the owner (telegram.send) goes to the installation's in-app message box.

export class JobTools implements ToolHost {
  private mock: MockTools | null = null;

  constructor(
    private rt: Runtime,
    private installation: AgentInstallation,
    private definition: AgentDefinition,
    private job: AgentJob | null,
  ) {}

  // The installation's stand-in data, read fresh when a job (re)starts.
  private async mocks(): Promise<MockTools> {
    if (this.mock) return this.mock;
    const [row] = await this.rt.db.select({ mocks: agentInstallations.mocks, memory: agentInstallations.memory }).from(agentInstallations).where(eq(agentInstallations.id, this.installation.id));
    this.mock = new MockTools({ ...emptyBench(), ...row!.mocks, memory: row!.memory });
    return this.mock;
  }

  async call(_step: AgentStep, tool: ToolName, args: unknown): Promise<unknown> {
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
