import styles from "./Wordmark.module.css";

// The product name, set in Onest bold like the chalk mockup.
export function Wordmark({ size = "md" }: { size?: "md" | "lg" }) {
  return (
    <span className={`${styles.mark} ${size === "lg" ? styles.lg : ""}`} aria-label="boardofserv">
      boardofserv
    </span>
  );
}
