import "server-only";
import { randomUUID } from "node:crypto";
import { count, gte, sql } from "drizzle-orm";
import { modelAttempts } from "./db/schema";
import { errorText } from "./db/errors";
import type { Attempt } from "./model";
import { MODEL_PURPOSES } from "./modelLimits";
import type { Runtime } from "./agents/runtime/context";

// The log of every try the SERV client made (model.ts returns them with each
// call): one row per try, the tries of one call under one call id. Written
// where each call's usage is recorded; a failure to write never stops the
// caller. The admin's model cost view reads the empty answer and retry
// rates from it.

type Db = Runtime["db"];

export async function recordAttempts(db: Db, attempts: Attempt[], o: { ownKey: boolean; at?: Date }): Promise<void> {
  if (!attempts.length) return;
  const callId = randomUUID();
  const at = o.at ?? new Date();
  try {
    await db.insert(modelAttempts).values(
      attempts.map((a) => ({
        callId,
        purpose: a.purpose,
        provider: a.provider,
        status: a.status,
        outcome: a.outcome,
        ms: a.ms,
        promptTokens: a.promptTokens,
        completionTokens: a.completionTokens,
        retry: a.retry,
        empty: a.empty,
        ownKey: o.ownKey,
        createdAt: at,
      })),
    );
  } catch (err) {
    console.error("model attempts not recorded", errorText(err, "unknown error"));
  }
}

export interface AnswerRates {
  purpose: string;
  // Calls, and the tries they took.
  calls: number;
  attempts: number;
  // Tries whose answer came back empty (or with nothing usable).
  empty: number;
  // Calls that took more than one try.
  retried: number;
}

// Since a moment (the admin view: this week), by purpose, in the order
// modelLimits.ts lists them.
export async function answerRates(db: Db, since: Date): Promise<AnswerRates[]> {
  const calls = await db
    .select({
      purpose: sql<string>`min(${modelAttempts.purpose})`,
      tries: count(),
      empty: sql<number>`count(*) filter (where ${modelAttempts.empty})::int`,
    })
    .from(modelAttempts)
    .where(gte(modelAttempts.createdAt, since))
    .groupBy(modelAttempts.callId);
  const by = new Map<string, AnswerRates>();
  for (const c of calls) {
    const r = by.get(c.purpose) ?? { purpose: c.purpose, calls: 0, attempts: 0, empty: 0, retried: 0 };
    r.calls += 1;
    r.attempts += Number(c.tries);
    r.empty += Number(c.empty);
    if (Number(c.tries) > 1) r.retried += 1;
    by.set(c.purpose, r);
  }
  const order = (p: string) => {
    const i = MODEL_PURPOSES.indexOf(p as (typeof MODEL_PURPOSES)[number]);
    return i < 0 ? MODEL_PURPOSES.length : i;
  };
  return [...by.values()].sort((a, b) => order(a.purpose) - order(b.purpose) || a.purpose.localeCompare(b.purpose));
}
