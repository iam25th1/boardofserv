import { DrizzleQueryError } from "drizzle-orm/errors";

// Since drizzle-orm 0.44 a failed query throws a DrizzleQueryError: its
// message is the query and its parameters ("Failed query: ...\nparams:
// ..."), and its cause is the database's own error. These keep what the
// code saw before: the database's error code, and, wherever an error's
// words go to a person or a log, the database's message without the query
// or its parameters.

export function pgCode(err: unknown): string | undefined {
  for (let e = err as { code?: unknown; cause?: unknown } | undefined, depth = 0; e && depth < 4; e = e.cause as typeof e, depth++) {
    if (typeof e.code === "string") return e.code;
  }
  return undefined;
}

// A unique violation, from node-postgres or PGlite, wrapped or not.
export const isUniqueViolation = (err: unknown): boolean => pgCode(err) === "23505";

export function errorText(err: unknown, fallback: string): string {
  if (err instanceof DrizzleQueryError) return err.cause instanceof Error ? err.cause.message : "A database query failed.";
  return err instanceof Error ? err.message : fallback;
}
