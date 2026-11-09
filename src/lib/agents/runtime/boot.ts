import "server-only";
import { dbPool } from "../../db";
import { errorCode } from "../../payments/worker";
import { paymentsWorker, runEvery } from "../../payments/workerLock";
import { serverRuntime } from "./context";
import { JOBS_WORKER_LOCK, jobWorker } from "./worker";

// Starts the agents' job worker when the server starts (src/instrumentation.ts).
//
// It runs in the Next server process rather than a process of its own. On
// Pier the app is one `next start` process: a second process would be a
// second service to deploy and watch, and would need the server-only code
// built to run outside Next. The cost is that a job shares the server's
// event loop and memory: a code step's sandbox runs synchronously (up to its
// 5 second limit), so at most CAPACITY jobs run at once, every tool call
// yields, and every step has a time and memory limit. Moving it out later is
// a small entry script calling this.
//
// BOS_AGENT_WORKER=0 turns it off in a process. Without a database it
// doesn't start.
let booted = false;

export function bootJobs(): void {
  if (booted) return;
  booted = true;
  if (process.env.BOS_AGENT_WORKER === "0") return void console.info("jobs: the agents' job worker is off in this process (BOS_AGENT_WORKER=0).");
  if (!process.env.DATABASE_URL) return void console.info("jobs: no database, so the agents' job worker isn't running.");
  const rt = serverRuntime();
  const worker = jobWorker(rt);
  const locked = paymentsWorker({
    connect: () => dbPool().connect(),
    cycle: () => worker.cycle(),
    hold: process.env.NODE_ENV === "production",
    key: JOBS_WORKER_LOCK,
    lines: {
      ran: "jobs: this process holds the job worker lock and runs the agents' jobs.",
      skipped: "jobs: another process holds the job worker lock, so this one runs no agents' jobs while it does.",
    },
  });
  runEvery(locked, {
    firstMs: 5_000,
    intervalMs: 5_000,
    followMs: 3_000,
    onError: (err) => console.error(`jobs: worker cycle failed: ${errorCode(err)}`),
  });
}
