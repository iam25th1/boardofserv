import "server-only";
import type { AgentDefinition } from "./definition";
import { runAgent } from "./runner";
import type { BenchData, RunEvent, StepCode } from "./types";
import restock from "./examples/restock.json";

// The example agent for /demo?agent=restock: a dry run of its saved steps
// and code on the bench the demo sends, every tool a mock and every decision
// a recorded answer, so no model is ever called. Development only: the route
// that imports this does so inside a development-only branch.

export async function runExample(bench: BenchData, onEvent: (e: RunEvent) => void, signal: AbortSignal) {
  const code = Object.fromEntries(Object.entries(restock.code).map(([k, c]) => [k, { ...c, spec: "", updatedAt: restock.builtAt } as StepCode]));
  return runAgent({ definition: restock.definition as AgentDefinition, code, bench, dryRun: true, onEvent, signal });
}
