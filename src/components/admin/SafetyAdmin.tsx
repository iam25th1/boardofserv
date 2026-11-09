"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { SkeletonPanel } from "@/components/ui";
import { ReviewPanel } from "@/components/agents/ReviewPanel";
import { formatAmount } from "@/lib/money";
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
      <section className={styles.section} aria-labelledby="costs-h">
        <h2 id="costs-h">Model cost this week</h2>
        {data.costs.length ? (
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Agent</th>
                <th scope="col">Runs for</th>
                <th scope="col">Calls</th>
                <th scope="col">Cost</th>
                <th scope="col">Site paid</th>
              </tr>
            </thead>
            <tbody>
              {data.costs.map((c) => (
                <tr key={c.installationId}>
                  <td>
                    {c.name} <span className={styles.quiet}>by @{c.maker}</span>
                  </td>
                  <td>@{c.owner}</td>
                  <td>{c.calls}</td>
                  <td>{formatAmount(BigInt(c.week), c.decimals)} USDC</td>
                  <td>{formatAmount(BigInt(c.sitePaid), c.decimals)} USDC</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className={styles.quiet}>No agent has made a model call this week.</p>
        )}
      </section>
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
