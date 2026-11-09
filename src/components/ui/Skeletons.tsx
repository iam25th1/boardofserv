import { Skeleton } from "./Skeleton";
import styles from "./Skeletons.module.css";

// Loading, in chalk: the shapes of what is coming, outlined and breathing in
// opacity (no gradient, no sweep; still with reduced motion). Each says
// what it waits for to a screen reader.

export function SkeletonCards({ count = 6, label }: { count?: number; label: string }) {
  return (
    <div className={styles.cards} role="status" aria-label={label}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={styles.card}>
          <Skeleton width="55%" height="18px" />
          <Skeleton width="92%" height="12px" />
          <Skeleton width="78%" height="12px" />
          <div className={styles.foot}>
            <Skeleton width="30%" height="12px" />
            <Skeleton width="22%" height="12px" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function SkeletonRows({ count = 4, label }: { count?: number; label: string }) {
  return (
    <div className={styles.rows} role="status" aria-label={label}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={styles.row}>
          <Skeleton width="28px" height="28px" radius="var(--r-full)" />
          <div className={styles.lines}>
            <Skeleton width={`${60 - (i % 3) * 12}%`} height="14px" />
            <Skeleton width={`${85 - (i % 2) * 20}%`} height="11px" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function SkeletonPanel({ label, lines = 5 }: { label: string; lines?: number }) {
  return (
    <div className={styles.panel} role="status" aria-label={label}>
      <Skeleton width="40%" height="22px" />
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} width={`${90 - (i % 3) * 15}%`} height="12px" />
      ))}
    </div>
  );
}
