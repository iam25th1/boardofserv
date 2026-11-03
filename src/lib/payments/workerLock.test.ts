// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { paymentsWorker, type LockConnection, type PaymentsWorker, type WorkerOptions } from "./workerLock";

// An advisory lock belongs to a Postgres session, so two workers have to be
// two real connections to one real server: PGlite has a single session and
// would grant the lock to both. CI runs a Postgres for this (ci.yml);
// locally, point TEST_POSTGRES_URL at a scratch server. The test uses a key
// of its own, never the real worker's.
const URL = process.env.TEST_POSTGRES_URL;
if (process.env.CI && !URL) throw new Error("TEST_POSTGRES_URL must be set in CI: the worker lock needs a real Postgres.");

const KEY = 0x626f73746573746bn; // "bostestk"
const RUNS = "payments: this process holds the worker lock and runs the payments cycles.";
const SKIPS = "payments: another process holds the worker lock, so this one skips its payments cycles while it does.";
const quiet = () => {};

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { open, opened };
}

describe.skipIf(!URL)("the payments worker lock, on a real Postgres", () => {
  let a: pg.Pool;
  let b: pg.Pool;
  const made: PaymentsWorker[] = [];

  beforeAll(() => {
    a = new pg.Pool({ connectionString: URL, max: 4 });
    b = new pg.Pool({ connectionString: URL, max: 4 });
  });
  afterEach(async () => {
    for (const w of made.splice(0)) await w.stop();
  });
  afterAll(async () => {
    await a.end();
    await b.end();
  });

  // A worker as one server process would make it, on its own pool.
  function worker(pool: pg.Pool, o: Partial<WorkerOptions> = {}): PaymentsWorker {
    const w = paymentsWorker({ connect: () => pool.connect(), cycle: async () => {}, hold: true, key: KEY, log: quiet, ...o });
    made.push(w);
    return w;
  }

  // Sessions holding the test key right now.
  async function holders(): Promise<number> {
    const { rows } = await a.query(
      "select count(*)::int as n from pg_locks where locktype = 'advisory' and granted and classid = $1 and objid = $2",
      [Number(KEY >> 32n), Number(KEY & 0xffffffffn)],
    );
    return rows[0].n;
  }

  it("two workers on one database: only one runs cycles, the other skips and says so once", async () => {
    const ran = { a: 0, b: 0 };
    const logA: string[] = [];
    const logB: string[] = [];
    const wa = worker(a, { cycle: async () => void ran.a++, log: (l) => logA.push(l) });
    const wb = worker(b, { cycle: async () => void ran.b++, log: (l) => logB.push(l) });

    for (let i = 0; i < 3; i++) {
      expect(await wa.tick()).toBe("ran");
      // Between a's cycles as well as during them.
      expect(await wb.tick()).toBe("skipped");
    }
    expect(ran).toEqual({ a: 3, b: 0 });
    expect(await holders()).toBe(1);
    expect(logA).toEqual([RUNS]);
    expect(logB).toEqual([SKIPS]);

    // a goes away: b takes over at its next cycle, and says that once.
    await wa.stop();
    expect(await wb.tick()).toBe("ran");
    expect(await wa.tick()).toBe("skipped");
    expect(logB).toEqual([SKIPS, RUNS]);
    expect(ran).toEqual({ a: 3, b: 1 });
  });

  it("also while a cycle is running", async () => {
    const inCycle = gate();
    const finish = gate();
    let ranB = 0;
    const wa = worker(a, {
      cycle: async () => {
        inCycle.open();
        await finish.opened;
      },
    });
    const wb = worker(b, { cycle: async () => void ranB++ });
    const first = wa.tick();
    await inCycle.opened;
    expect(await wb.tick()).toBe("skipped");
    finish.open();
    expect(await first).toBe("ran");
    expect(ranB).toBe(0);
  });

  it("two workers starting a cycle at the same moment: exactly one runs it", async () => {
    let running = 0;
    let most = 0;
    const cycle = async () => {
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 300));
      running--;
    };
    const [r1, r2] = await Promise.all([worker(a, { cycle }).tick(), worker(b, { cycle }).tick()]);
    expect([r1, r2].sort()).toEqual(["ran", "skipped"]);
    expect(most).toBe(1);
    expect(await holders()).toBe(1);
  });

  it("releases the lock when a cycle throws, so another worker takes over", async () => {
    const wa = worker(a, {
      cycle: async () => {
        throw new Error("the scan blew up");
      },
    });
    await expect(wa.tick()).rejects.toThrow("the scan blew up");
    expect(await holders()).toBe(0);
    let ranB = false;
    expect(await worker(b, { cycle: async () => void (ranB = true) }).tick()).toBe("ran");
    expect(ranB).toBe(true);
  });

  it("a process that dies frees the lock: its connection closes", async () => {
    const dying = new pg.Client({ connectionString: URL });
    await dying.connect();
    const wa = worker(a, { connect: async () => ({ query: (t, v) => dying.query(t, v), release: () => {} }) });
    expect(await wa.tick()).toBe("ran");
    expect(await holders()).toBe(1);
    const wb = worker(b);
    expect(await wb.tick()).toBe("skipped");
    // The process goes away.
    await dying.end();
    expect(await holders()).toBe(0);
    expect(await wb.tick()).toBe("ran");
  });

  it("a development server gives the lock back after each cycle, so a deployed one takes over and keeps it", async () => {
    const dev = worker(a, { hold: false });
    const prod = worker(b, { hold: true });
    expect(await dev.tick()).toBe("ran");
    expect(await holders()).toBe(0);
    expect(await prod.tick()).toBe("ran");
    expect(await dev.tick()).toBe("skipped");
    expect(await dev.tick()).toBe("skipped");
    expect(await holders()).toBe(1);
  });

  it("payments work asked for in a request runs under the same lock", async () => {
    let paid = 0;
    const wa = worker(a);
    const wb = worker(b);
    expect(await wa.tick()).toBe("ran");
    expect(await wb.run(async () => void paid++)).toBe("skipped");
    expect(await wa.run(async () => void paid++)).toBe("ran");
    expect(paid).toBe(1);
  });
});

// The same rules against a connection that records what it was asked, so
// they run everywhere, with or without a Postgres.
describe("the payments worker lock, its own rules", () => {
  function fake(o: { locked?: () => boolean; unlockFails?: boolean } = {}) {
    const calls: string[] = [];
    const released: (Error | boolean | undefined)[] = [];
    const connect = async (): Promise<LockConnection> => ({
      async query(text) {
        const what = text.includes("unlock") ? "unlock" : text.includes("try_advisory") ? "lock" : "check";
        calls.push(what);
        if (what === "unlock" && o.unlockFails) throw new Error("connection terminated");
        return { rows: [{ locked: o.locked ? o.locked() : true }] };
      },
      release(err) {
        released.push(err);
      },
    });
    return { connect, calls, released };
  }

  it("a holding worker keeps one connection and checks it before each cycle", async () => {
    const f = fake();
    const w = paymentsWorker({ connect: f.connect, hold: true, log: quiet, cycle: async () => {} });
    await w.tick();
    await w.tick();
    await w.tick();
    expect(f.calls).toEqual(["lock", "check", "check"]);
    expect(f.released).toEqual([]);
  });

  it("gives the lock and its connection back after a cycle that throws", async () => {
    const f = fake();
    const w = paymentsWorker({ connect: f.connect, hold: true, log: quiet, cycle: async () => Promise.reject(new Error("boom")) });
    await expect(w.tick()).rejects.toThrow("boom");
    expect(f.calls).toEqual(["lock", "unlock"]);
    expect(f.released).toEqual([undefined]);
  });

  it("drops the connection, and the lock with it, when the unlock itself fails", async () => {
    const f = fake({ unlockFails: true });
    const w = paymentsWorker({ connect: f.connect, hold: false, log: quiet, cycle: async () => {} });
    expect(await w.tick()).toBe("ran");
    expect(f.released).toHaveLength(1);
    expect(f.released[0]).toBeInstanceOf(Error);
  });

  it("skips without running the cycle when the lock is taken, and logs that once", async () => {
    const lines: string[] = [];
    let ran = 0;
    const f = fake({ locked: () => false });
    const w = paymentsWorker({ connect: f.connect, hold: true, log: (l) => lines.push(l), cycle: async () => void ran++ });
    for (let i = 0; i < 5; i++) expect(await w.tick()).toBe("skipped");
    expect(ran).toBe(0);
    expect(lines).toEqual([SKIPS]);
    expect(f.released).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });

  it("logs each change of role once: running, skipping, running again", async () => {
    const lines: string[] = [];
    let free = true;
    const f = fake({ locked: () => free });
    const w = paymentsWorker({ connect: f.connect, hold: false, log: (l) => lines.push(l), cycle: async () => {} });
    await w.tick();
    await w.tick();
    free = false;
    await w.tick();
    await w.tick();
    free = true;
    await w.tick();
    expect(lines).toEqual([RUNS, SKIPS, RUNS]);
  });

  it("never runs two pieces of work at once within a process", async () => {
    const f = fake();
    let running = 0;
    let most = 0;
    const task = async () => {
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 20));
      running--;
    };
    const w = paymentsWorker({ connect: f.connect, hold: true, log: quiet, cycle: task });
    await Promise.all([w.tick(), w.run(task), w.tick()]);
    expect(most).toBe(1);
  });
});
