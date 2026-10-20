import "server-only";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

// One pooled connection for the server, created lazily on first use so that
// importing this module (for example during the build) never opens a
// connection or requires DATABASE_URL to be set yet.
const g = globalThis as unknown as { __bosPool?: pg.Pool; __bosDb?: NodePgDatabase<typeof schema> };

function getDb(): NodePgDatabase<typeof schema> {
  if (!g.__bosDb) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    g.__bosPool ??= new pg.Pool({ connectionString, max: 5 });
    g.__bosDb = drizzle(g.__bosPool, { schema });
  }
  return g.__bosDb;
}

// A lazy handle: property access initialises the real client on first touch.
export const db = new Proxy({} as NodePgDatabase<typeof schema>, {
  get(_t, prop) {
    return Reflect.get(getDb(), prop, getDb());
  },
});

export { schema };
