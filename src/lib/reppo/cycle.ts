import "server-only";
import type { Runtime } from "../agents/runtime/context";
import type { CallOptions } from "./client";
import { pollDue, submitDue } from "./evals";
import { onOpinion } from "./opinion";
import { onJobResult } from "./blocks";
import { reppoSettings, sampleFinished, submitRoom } from "./sampling";

// Reppo's part of the job worker's cycle: sample jobs that finished, submit
// what is queued within the day's credits, read back what is due. It runs beside the jobs, never in their way: the worker
// starts it without waiting for it, and starts no second one while one is
// still going.
export async function reppoCycle(rt: Runtime, o: { call?: CallOptions } = {}): Promise<void> {
  if (!rt.services.reppo) return;
  const settings = reppoSettings();
  await sampleFinished(rt, settings);
  await submitDue(rt, { room: (r, row) => submitRoom(r, row, settings), call: o.call });
  await pollDue(rt, {
    onResult: async (r, row) => {
      await onOpinion(r, row);
      await onJobResult(r, row);
    },
    call: o.call,
  });
}
