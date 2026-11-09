import "server-only";
import type { Runtime } from "../agents/runtime/context";
import { pollDue, submitDue } from "./evals";

// Reppo's part of the job worker's cycle: submit what is queued, read back
// what is due. It runs beside the jobs, never in their way: the worker
// starts it without waiting for it, and starts no second one while one is
// still going.
export async function reppoCycle(rt: Runtime): Promise<void> {
  if (!rt.services.reppo) return;
  await submitDue(rt);
  await pollDue(rt);
}
