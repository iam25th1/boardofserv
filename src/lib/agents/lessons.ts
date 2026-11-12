import "server-only";
import { desc, sql } from "drizzle-orm";
import { db } from "../db";
import { agentLessons } from "../db/schema";
import { fixDashes } from "../dashes";

// Lessons: every repair that fixed a build (fixer.ts) is kept as a short
// rule with what went wrong and what fixed it, counted each time the same
// kind of mistake is put right. A mistake that keeps coming back, from more
// than one maker's builds, becomes a rule the planner and Dolphin are given
// up front, so it gets rarer. The admin view lists them by how often.

const STOP = new Set(["a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "it", "its", "is", "be", "that", "this", "with", "never", "always", "step", "steps"]);

// The same lesson, however SERV words it next time: its kind and the first
// words that carry its meaning.
export function lessonKey(kind: string, rule: string): string {
  const words = rule
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w))
    .slice(0, 8)
    .join(" ");
  return `${kind}:${words}`;
}

const MAX_MAKERS = 20;

// A repair that fixed a build: learned, or counted once more.
export async function learn(o: { kind: string; rule: string; wrong: string; fix: string; makerId: string }): Promise<void> {
  const rule = fixDashes(o.rule).replace(/\s+/g, " ").trim().slice(0, 300);
  if (!rule) return;
  const key = lessonKey(o.kind, rule);
  const wrong = fixDashes(o.wrong).slice(0, 500);
  const fix = fixDashes(o.fix).slice(0, 500);
  await db
    .insert(agentLessons)
    .values({ key, kind: o.kind, rule, wrong, fix, makers: [o.makerId] })
    .onConflictDoUpdate({
      target: agentLessons.key,
      set: {
        count: sql`${agentLessons.count} + 1`,
        wrong,
        fix,
        lastSeenAt: new Date(),
        makers: sql`case when ${agentLessons.makers} ? ${o.makerId} or jsonb_array_length(${agentLessons.makers}) >= ${MAX_MAKERS} then ${agentLessons.makers} else ${agentLessons.makers} || jsonb_build_array(${o.makerId}::text) end`,
      },
    });
}

export interface Lesson {
  kind: string;
  rule: string;
  wrong: string;
  fix: string;
  count: number;
  makers: number;
  lastSeenAt: string;
}

// Every lesson, the most often learned first.
export async function lessonsByCount(limit = 200): Promise<Lesson[]> {
  const rows = await db.select().from(agentLessons).orderBy(desc(agentLessons.count), desc(agentLessons.lastSeenAt)).limit(limit);
  return rows.map((r) => ({ kind: r.kind, rule: r.rule, wrong: r.wrong, fix: r.fix, count: r.count, makers: r.makers.length, lastSeenAt: r.lastSeenAt.toISOString() }));
}

// The rules that keep coming back: a kind of mistake put right at least
// twice, in more than one maker's builds, as its most often learned rule
// (a mistake of no named kind only when its own rule recurs). The most
// common first, a few at most.
export async function recurringRules(limit = 6): Promise<string[]> {
  const rows = await db.select().from(agentLessons).orderBy(desc(agentLessons.count), desc(agentLessons.lastSeenAt)).limit(200);
  const byKind = new Map<string, { rule: string; count: number; makers: Set<string> }>();
  for (const r of rows) {
    const k = r.kind === "other" ? r.key : r.kind;
    const g = byKind.get(k) ?? { rule: r.rule, count: 0, makers: new Set<string>() };
    g.count += r.count;
    for (const m of r.makers) g.makers.add(m);
    byKind.set(k, g);
  }
  return [...byKind.values()]
    .filter((g) => g.count >= 2 && g.makers.size >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map((g) => g.rule);
}
