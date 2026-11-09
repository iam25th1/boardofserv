"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { SkeletonPanel } from "@/components/ui";
import { ReviewPanel } from "@/components/agents/ReviewPanel";
import type { AdminSafetyDTO } from "@/lib/types";
import styles from "./SafetyAdmin.module.css";

// The admin's safety page: every version's code review, newest first.

export interface SafetyAdminApi {
  load: () => Promise<AdminSafetyDTO>;
}

export function SafetyAdmin({ api }: { api: SafetyAdminApi }) {
  const [data, setData] = useState<AdminSafetyDTO | null | undefined>(undefined);
  const load = useCallback(() => api.load().then(setData, () => setData(null)), [api]);
  useEffect(() => {
    void load();
  }, [load]);
  if (data === undefined) return <SkeletonPanel label="Getting the safety page" lines={6} />;
  if (data === null) return <p className={styles.quiet}>This page could not load. Try again in a moment.</p>;
  return (
    <div className={styles.page}>
      <section className={styles.section} aria-labelledby="reviews-h">
        <h2 id="reviews-h">Code reviews</h2>
        {data.reviews.length ? (
          <ul className={styles.list}>
            {data.reviews.map((r) => (
              <li key={r.versionId}>
                <p className={styles.who}>
                  <strong>{r.name}</strong> version {r.version}, by @{r.maker}, {r.state === "published" ? "published" : "a draft"}
                </p>
                <ReviewPanel review={r.review} />
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.quiet}>No version has been reviewed yet.</p>
        )}
      </section>
      <Link href="/app/admin" className={styles.back}>
        Payments and accounts
      </Link>
    </div>
  );
}
