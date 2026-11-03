import "server-only";
import { dbPool } from "../db";
import { scanTick } from "./deposits";
import { sweepTick } from "./uses";
import { payoutTick } from "./withdrawals";
import { paymentsWorker, type PaymentsWorker } from "./workerLock";

// The payments work this process runs, always under the worker lock
// (workerLock.ts), so two servers on one database never run it at once.

// One round of the payments work. Each part logs its own failures.
export async function paymentsTick(): Promise<void> {
  await scanTick();
  await sweepTick();
  await payoutTick();
}

// One worker per process, made when the interval starts (boot.ts). It lives
// on globalThis because route handlers are bundled apart from the boot code
// and must reach the same one. A production server keeps the lock between
// cycles; a development server gives it back after each, so a deployed
// service on the same database takes over.
const g = globalThis as unknown as { __bosWorker?: PaymentsWorker };

export function processWorker(): PaymentsWorker {
  g.__bosWorker ??= paymentsWorker({
    connect: () => dbPool().connect(),
    cycle: paymentsTick,
    hold: process.env.NODE_ENV === "production",
  });
  return g.__bosWorker;
}

// A payout asked for in a request: sent now when this process holds the lock
// or can take it; otherwise the process holding it sends it in its cycle. A
// process that runs no payments work (BOS_PAYMENTS_WORKER=0) leaves it to
// the one that does. Errors are logged, never thrown: nothing waits for this.
export async function payoutSoon(): Promise<void> {
  const worker = g.__bosWorker;
  if (!worker) return;
  try {
    await worker.run(() => payoutTick());
  } catch (err) {
    console.error(`payments: payout step failed: ${errorCode(err)}`);
  }
}

// A connection error (the database is down) by its code, never by a message
// that could carry more.
export function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : err instanceof Error ? err.name : "unknown error";
}
