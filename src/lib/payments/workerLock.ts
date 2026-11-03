// One payments worker at a time, across every process on the database.
//
// The deposit scan, the hold sweep and payouts run as one cycle on an
// interval in each server process (see boot.ts). Two processes can share a
// database (a development server next to the deployed one), so before each
// cycle the worker makes sure it holds a Postgres advisory lock, taken on a
// connection of its own; a process that can't take it skips that cycle.
//
// A production process keeps the lock between cycles, so while it runs it is
// the only worker and every other process skips. A development process
// (hold: false) gives it back after each cycle, and a production process that
// finds the lock taken tries again after a few seconds rather than a whole
// interval (runEvery), so it takes the lock in the gap after a development
// server's cycle and keeps it, even when both tick in step. The lock is given
// back when a cycle throws, so a failing worker steps aside, and when a
// process dies its connection closes and Postgres drops the lock with it.
//
// The log says which process runs the cycles: one line when a process starts
// running them and one when it starts skipping them, never a line per skip.

// "bosworkr" in ASCII. withdrawals.ts takes 0x626f7377 ("bosw") for requests,
// a different key.
export const PAYMENTS_WORKER_LOCK = 0x626f73776f726b72n;

// One database connection, kept while the lock is held. pg's PoolClient
// fits: release(err) destroys the connection instead of returning it.
export interface LockConnection {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(err?: Error | boolean): void;
}

export interface WorkerOptions {
  connect: () => Promise<LockConnection>;
  cycle: () => Promise<void>;
  // Keep the lock between cycles (production) or give it back after each.
  hold: boolean;
  key?: bigint;
  log?: (line: string) => void;
}

export interface PaymentsWorker {
  // Whether it keeps the lock between cycles.
  readonly hold: boolean;
  // One cycle, if this process holds the lock or can take it. A cycle's own
  // error is passed on once the lock is given back.
  tick(): Promise<"ran" | "skipped">;
  // Some other payments work (a payout asked for in a request) under the
  // same lock, never alongside a cycle.
  run(task: () => Promise<void>): Promise<"ran" | "skipped">;
  // Give the lock back, for a clean shutdown.
  stop(): Promise<void>;
}

export function paymentsWorker({ connect, cycle, hold, key = PAYMENTS_WORKER_LOCK, log = (l) => console.info(l) }: WorkerOptions): PaymentsWorker {
  const k = key.toString();
  let held: LockConnection | null = null;
  let role: "ran" | "skipped" | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const say = (now: "ran" | "skipped") => {
    if (role === now) return;
    role = now;
    log(
      now === "ran"
        ? "payments: this process holds the worker lock and runs the payments cycles."
        : "payments: another process holds the worker lock, so this one skips its payments cycles while it does.",
    );
  };

  // Holds the lock after this, or says why not.
  async function take(): Promise<boolean> {
    if (held) {
      try {
        // The lock lasts as long as its connection: still there, still ours.
        await held.query("select 1");
        return true;
      } catch (err) {
        const gone = held;
        held = null;
        gone.release(err instanceof Error ? err : true);
      }
    }
    const conn = await connect();
    let locked: boolean;
    try {
      const { rows } = await conn.query("select pg_try_advisory_lock($1::bigint) as locked", [k]);
      locked = rows[0]?.locked === true;
    } catch (err) {
      conn.release(err instanceof Error ? err : true);
      throw err;
    }
    if (!locked) {
      conn.release();
      return false;
    }
    held = conn;
    return true;
  }

  async function giveBack(): Promise<void> {
    const conn = held;
    if (!conn) return;
    held = null;
    try {
      await conn.query("select pg_advisory_unlock($1::bigint)", [k]);
      conn.release();
    } catch (err) {
      // The connection is unusable: dropping it drops the lock with it.
      conn.release(err instanceof Error ? err : true);
    }
  }

  async function locked(task: () => Promise<void>): Promise<"ran" | "skipped"> {
    if (!(await take())) {
      say("skipped");
      return "skipped";
    }
    say("ran");
    try {
      await task();
    } catch (err) {
      await giveBack();
      throw err;
    }
    if (!hold) await giveBack();
    return "ran";
  }

  // One at a time within the process too.
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  };

  return {
    hold,
    tick: () => serial(() => locked(cycle)),
    run: (task) => serial(() => locked(task)),
    stop: () => serial(giveBack),
  };
}

export interface Schedule {
  // The first cycle, soon after the server starts.
  firstMs: number;
  intervalMs: number;
  // How soon a worker that keeps the lock tries again after finding it taken.
  followMs: number;
  onError: (err: unknown) => void;
}

// Runs the worker's cycle on an interval, one at a time. Returns a stop.
export function runEvery(worker: PaymentsWorker, { firstMs, intervalMs, followMs, onError }: Schedule): () => void {
  let busy = false;
  let follow: ReturnType<typeof setTimeout> | null = null;
  const tick = async () => {
    if (busy) return;
    busy = true;
    let result: "ran" | "skipped" | null = null;
    try {
      result = await worker.tick();
    } catch (err) {
      onError(err);
    } finally {
      busy = false;
    }
    if (result === "skipped" && worker.hold && !follow) {
      follow = setTimeout(() => {
        follow = null;
        void tick();
      }, followMs);
      follow.unref?.();
    }
  };
  const first = setTimeout(() => void tick(), firstMs);
  const every = setInterval(() => void tick(), intervalMs);
  first.unref?.();
  every.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(every);
    if (follow) clearTimeout(follow);
  };
}
