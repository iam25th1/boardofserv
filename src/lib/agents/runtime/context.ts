import "server-only";
import { db } from "../../db";

// What the runtime works with: the database and the clock. The server's
// runtime uses the real ones; tests and the development demo pass their own
// (an in-memory Postgres, a clock they move).

export type Db = typeof db;

export interface Runtime {
  db: Db;
  now: () => Date;
}

export function serverRuntime(): Runtime {
  return { db, now: () => new Date() };
}
