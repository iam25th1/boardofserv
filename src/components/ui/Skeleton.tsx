import * as React from "react";
import styles from "./Skeleton.module.css";

export interface SkeletonProps {
  width?: string;
  height?: string;
  radius?: string;
  className?: string;
}

export function Skeleton({ width, height, radius = "var(--r-sm)", className }: SkeletonProps) {
  const classes = [styles.skeleton, className ?? ""].filter(Boolean).join(" ");
  const style: React.CSSProperties = { width, height, borderRadius: radius };
  return <span className={classes} aria-hidden="true" style={style} />;
}
