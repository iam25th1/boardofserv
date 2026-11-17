import "server-only";
import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { agentLessons } from "../db/schema";
import { fixDashes } from "../dashes";
import type { HealLog } from "./types";

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

// A repair that fixed a build: learned, or counted once more. recipe: a
// tested recipe's own lesson, learned when a build from it went live with
// the fix (live), kept apart from the rest.
export async function learn(o: { kind: string; rule: string; wrong: string; fix: string; makerId: string; recipe?: string | null; live?: boolean }): Promise<void> {
  const rule = fixDashes(o.rule).replace(/\s+/g, " ").trim().slice(0, 300);
  if (!rule) return;
  const key = `${o.recipe ? `${o.recipe}/` : ""}${lessonKey(o.kind, rule)}`;
  const wrong = fixDashes(o.wrong).slice(0, 500);
  const fix = fixDashes(o.fix).slice(0, 500);
  const live = o.live ? 1 : 0;
  await db
    .insert(agentLessons)
    .values({ key, kind: o.kind, rule, wrong, fix, makers: [o.makerId], recipe: o.recipe ?? null, live })
    .onConflictDoUpdate({
      target: agentLessons.key,
      set: {
        count: sql`${agentLessons.count} + 1`,
        live: sql`${agentLessons.live} + ${live}`,
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
  const rows = await db.select().from(agentLessons).where(isNull(agentLessons.recipe)).orderBy(desc(agentLessons.count), desc(agentLessons.lastSeenAt)).limit(200);
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

// A recipe's own lessons (learn with recipe): the fixes builds from it
// needed before they went live, the most proven first, for the planner and
// the fixer of its next builds. Every recipe's ("all", for a plan not yet
// made), each said with its recipe; none for null (a plan from scratch).
export async function recipeRules(recipe: string | "all" | null, limit = 4): Promise<string[]> {
  if (!recipe) return [];
  const rows = await db
    .select()
    .from(agentLessons)
    .where(and(recipe === "all" ? isNotNull(agentLessons.recipe) : eq(agentLessons.recipe, recipe), sql`${agentLessons.live} > 0`))
    .orderBy(desc(agentLessons.live), desc(agentLessons.count), desc(agentLessons.lastSeenAt))
    .limit(recipe === "all" ? 50 : limit);
  if (recipe !== "all") return rows.map((r) => r.rule);
  const per = new Map<string, number>();
  return rows
    .filter((r) => {
      const n = per.get(r.recipe!) ?? 0;
      per.set(r.recipe!, n + 1);
      return n < 2;
    })
    .map((r) => `For the ${r.recipe} recipe: ${r.rule}`);
}

// A version gone live: each fix that got it there, from a build that
// started from a tested recipe, is kept as that recipe's lesson (the plan
// each failure was found on says which recipe it was).
export async function learnFromLive(log: HealLog | null | undefined, makerId: string): Promise<void> {
  for (const r of log?.rounds ?? []) {
    const recipe = (r.diagnosis.evidence.plan as { recipe?: { id?: unknown } } | null)?.recipe?.id;
    if (r.outcome !== "fixed" || !r.lesson?.text || typeof recipe !== "string") continue;
    await learn({ kind: r.lesson.kind, rule: r.lesson.text, wrong: r.diagnosis.failure, fix: r.repair || r.why, makerId, recipe, live: true });
  }
}
