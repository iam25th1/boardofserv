"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { SkeletonPanel } from "@/components/ui";
import type { LessonDTO } from "@/lib/types";
import styles from "./LessonsAdmin.module.css";

// The admin's lessons: every repair that fixed a build, as a rule, by how
// often it was learned and in how many makers' builds. One learned more
// than once, in more than one maker's builds, goes to the planner and
// Dolphin as a rule (agents/lessons.ts).

const KIND: Record<string, string> = {
  invented_input: "Reading inputs it wasn't given",
  nothing_to_do: "Skipping when it should act",
  extra_question: "A question nobody asked for",
  allowance_check: "Its own allowance check",
  wrong_tools: "The wrong tools",
  missing_step: "A step missing",
  extra_step: "A step too many",
  wrong_value: "The wrong value",
  judgement_in_code: "Judging in code",
  summary: "A summary that misses items",
  keeps_place: "Not keeping its place",
  sheet_columns: "Sheet columns",
  sample_payee: "The sample's payee",
  sample_answers: "The sample's answers",
  sample_items: "The sample's items",
  sample_dates: "The sample's dates",
  setup: "Its setup",
  other: "Other",
};

export function LessonsAdmin({ load }: { load: () => Promise<LessonDTO[]> }) {
  const [lessons, setLessons] = useState<LessonDTO[] | null | undefined>(undefined);
  useEffect(() => {
    load().then(setLessons, () => setLessons(null));
  }, [load]);
  if (lessons === undefined) return <SkeletonPanel label="Getting the lessons" lines={5} />;
  if (lessons === null) return <p className={styles.quiet}>This page could not load. Try again in a moment.</p>;
  return (
    <div className={styles.page}>
      <Link href="/app/admin" className={styles.back}>
        Back to admin
      </Link>
      {lessons.length === 0 ? (
        <p className={styles.quiet}>No lessons yet: they come as builds fix themselves.</p>
      ) : (
        <ol className={styles.list}>
          {lessons.map((l, i) => (
            <li key={`${l.kind}-${i}`} className={styles.lesson} data-fed={l.count >= 2 && l.makers >= 2 ? "true" : undefined}>
              <div className={styles.head}>
                <strong className={styles.count}>{l.count}</strong>
                <span className={styles.kind}>{KIND[l.kind] ?? l.kind}</span>
                <span className={styles.meta}>
                  {l.makers} {l.makers === 1 ? "maker" : "makers"}, last {new Date(l.lastSeenAt).toLocaleDateString()}
                  {l.count >= 2 && l.makers >= 2 ? ", given to the planner and Dolphin" : ""}
                </span>
              </div>
              <p className={styles.rule}>{l.rule}</p>
              <dl className={styles.facts}>
                <dt>What went wrong</dt>
                <dd>{l.wrong}</dd>
                <dt>What fixed it</dt>
                <dd>{l.fix}</dd>
              </dl>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
