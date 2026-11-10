import "server-only";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import type { Runtime } from "./context";
import { beat, claimJob, HEARTBEAT_MS, requeueStale, runJob } from "./jobs";
import { reppoCycle } from "../../reppo/cycle";
import { settlePayments } from "../../spending/pay";
import { reconcile } from "../../spending/reconcile";
import { refreshTrust } from "../../trust/trust";
import { expireDue } from "./approvals";
import { fireDue } from "./triggers";
import { deliverTelegram, tidyTelegram } from "../../telegram/deliver";
import { chargeModelShares, settleJobFees } from "../../market/charges";
import { resumeAllowances } from "./allowances";
import { renewDue } from "../../market/rentals";

// The agents' job worker: one cycle every few seconds, in the server
// process (see boot.ts for why), under its own Postgres advisory lock taken
// the way the payments worker takes its own (payments/workerLock.ts), so
// only one process on a database runs the cycles. A cycle:
//
// 1. puts jobs whose worker stopped beating back in the queue,
// 2. fires the triggers that are due (triggers.ts), expires the approvals
//    nobody answered in time (approvals.ts), renews rented agents' weeks
//    and settles their fees per job (market/), and sends what waits to go
//    out to owners' Telegram chats (telegram/deliver.ts),
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
  let cycles = 0;
  let reppo: Promise<void> | null = null;
  let paying: Promise<void> | null = null;
  let trusting: Promise<void> | null = null;
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
      // Rented agents: weeks renewed (or paused when unpaid, or ended when
      // cancelled), and the fees of jobs that ended settled.
      await renewDue(rt).catch((err: unknown) => rt.log(`rentals: renewal broke off: ${err instanceof Error ? err.name : "unknown error"}`));
      await settleJobFees(rt).catch((err: unknown) => rt.log(`rentals: settling fees broke off: ${err instanceof Error ? err.name : "unknown error"}`));
      // Model cost: renters who pay their jobs' model cost are charged it,
      // and free agents paused for their allowance start again each week.
      await chargeModelShares(rt).catch((err: unknown) => rt.log(`rentals: charging model cost broke off: ${err instanceof Error ? err.name : "unknown error"}`));
      await resumeAllowances(rt).catch((err: unknown) => rt.log(`jobs: resuming allowances broke off: ${err instanceof Error ? err.name : "unknown error"}`));
      // Questions and messages out to owners' Telegram chats, and answered
      // questions' messages settled there.
      await deliverTelegram(rt).catch((err: unknown) => rt.log(`telegram: delivery broke off: ${err instanceof Error ? err.name : "unknown error"}`));
      if (++cycles % 720 === 1) await tidyTelegram(rt).catch(() => undefined);
      // Reppo's evaluations beside the jobs: never waited on here, so a slow
      // or broken Reppo never holds up a job.
      if (!reppo && rt.services.reppo) {
        reppo = reppoCycle(rt)
          .catch((err: unknown) => rt.log(`reppo: cycle broke off: ${err instanceof Error ? err.name : "unknown error"}`))
          .finally(() => {
            reppo = null;
          });
      }
      // Agents' payments whose jobs stopped waiting on them, settled beside
      // the jobs too (confirmed and spent, or released).
      if (!paying && rt.payments) {
        // And about once a minute, reconciled with the chain.
        const check = cycles % 12 === 1;
        paying = settlePayments(rt)
          .then(() => (check ? reconcile(rt) : null))
          .then(() => undefined)
          .catch((err: unknown) => rt.log(`payments: settling agent payments broke off: ${err instanceof Error ? err.name : "unknown error"}`))
          .finally(() => {
            paying = null;
          });
      }
      // Trust scores: versions whose jobs finished since, and daily.
      if (!trusting) {
        trusting = refreshTrust(rt)
          .then(() => undefined)
          .catch((err: unknown) => rt.log(`trust: refreshing scores broke off: ${err instanceof Error ? err.name : "unknown error"}`))
          .finally(() => {
            trusting = null;
          });
      }
      while (running.size < capacity) {
        const job = await claimJob(rt, id);
        if (!job) break;
        const run = runJob(rt, job, id)
          .catch((err: unknown) => rt.log(`jobs: job ${job.id} stopped: ${err instanceof Error ? err.name : "unknown error"}`))
          .finally(() => running.delete(job.id));
        running.set(job.id, run);
      }
    },
    running: () => [...running.values(), ...(reppo ? [reppo] : []), ...(paying ? [paying] : []), ...(trusting ? [trusting] : [])],
    stop: () => clearInterval(heart),
  };
}
