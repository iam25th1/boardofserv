import "server-only";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import type { Runtime } from "./context";
import { beat, claimJob, HEARTBEAT_MS, requeueStale, runJob } from "./jobs";
import { expireDue } from "./approvals";
import { fireDue } from "./triggers";

// The agents' job worker: one cycle every few seconds, in the server
// process (see boot.ts for why), under its own Postgres advisory lock taken
// the way the payments worker takes its own (payments/workerLock.ts), so
// only one process on a database runs the cycles. A cycle:
//
// 1. puts jobs whose worker stopped beating back in the queue,
// 2. fires the triggers that are due (triggers.ts) and expires the
//    approvals nobody answered in time (approvals.ts),
// 3. starts claimed jobs up to the worker's capacity, without waiting for
//    them: they run on, beating, while the next cycles go by.
//
// Claiming is atomic in the database as well, so even two processes that
// both ran cycles could never take the same job.

export const JOBS_WORKER_LOCK = 0x626f736a6f627321n; // "bosjobs!"
export const CAPACITY = 2;

export interface JobWorker {
  readonly id: string;
  cycle(): Promise<void>;
  // The jobs running in this process now (tests wait on them).
  running(): Promise<void>[];
  stop(): void;
}

export function jobWorker(rt: Runtime, capacity = CAPACITY): JobWorker {
  const id = `${hostname()}:${process.pid}:${randomBytes(4).toString("hex")}`;
  const running = new Map<string, Promise<void>>();
  const heart = setInterval(() => {
    beat(rt, id, [...running.keys()]).catch(() => undefined);
  }, HEARTBEAT_MS);
  heart.unref?.();

  return {
    id,
    async cycle() {
      const picked = await requeueStale(rt);
      if (picked) rt.log(`jobs: ${picked} ${picked === 1 ? "job" : "jobs"} left running by a stopped server went back in the queue.`);
      await fireDue(rt);
      const expired = await expireDue(rt);
      if (expired) rt.log(`jobs: ${expired} ${expired === 1 ? "approval" : "approvals"} expired with no answer.`);
      while (running.size < capacity) {
        const job = await claimJob(rt, id);
        if (!job) break;
        const run = runJob(rt, job, id)
          .catch((err: unknown) => rt.log(`jobs: job ${job.id} stopped: ${err instanceof Error ? err.name : "unknown error"}`))
          .finally(() => running.delete(job.id));
        running.set(job.id, run);
      }
    },
    running: () => [...running.values()],
    stop: () => clearInterval(heart),
  };
}
