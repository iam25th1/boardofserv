import "server-only";
import type { Runtime } from "../agents/runtime/context";
import { pollDue, submitDue } from "./evals";
import { reppoSettings, sampleFinished, submitRoom } from "./sampling";

// Reppo's part of the job worker's cycle: sample jobs that finished, submit
// what is queued within the day's credits, read back what is due. It runs beside the jobs, never in their way: the worker
// starts it without waiting for it, and starts no second one while one is
// still going.
export async function reppoCycle(rt: Runtime): Promise<void> {
  if (!rt.services.reppo) return;
  const settings = reppoSettings();
  await sampleFinished(rt, settings);
  await submitDue(rt, { room: (r, row) => submitRoom(r, row, settings) });
  await pollDue(rt);
}
