import "server-only";
import { eq } from "drizzle-orm";
import { agentInstallations, type AgentInstallation, type AgentJob } from "../../db/schema";
import type { AgentDefinition, AgentStep, ToolName } from "../definition";
import type { ToolHost } from "../runner";
import { MockTools } from "../toolbox";
import { emptyBench } from "../types";
import type { Runtime } from "./context";

// A job's tools. The ones that are still stand-ins (sheets, search, the
// wallet, Telegram) answer like the test bench's mocks, from the
// installation's own copy of the bench's data, and what they change is kept
// on the installation for its next job.

export class JobTools implements ToolHost {
  private mock: MockTools | null = null;

  constructor(
    private rt: Runtime,
    private installation: AgentInstallation,
    private definition: AgentDefinition,
    private job: AgentJob,
  ) {}

  // The installation's stand-in data, read fresh when a job (re)starts.
  private async mocks(): Promise<MockTools> {
    if (this.mock) return this.mock;
    const [row] = await this.rt.db.select({ mocks: agentInstallations.mocks, memory: agentInstallations.memory }).from(agentInstallations).where(eq(agentInstallations.id, this.installation.id));
    this.mock = new MockTools({ ...emptyBench(), ...row!.mocks, memory: row!.memory });
    return this.mock;
  }

  async call(_step: AgentStep, tool: ToolName, args: unknown): Promise<unknown> {
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
