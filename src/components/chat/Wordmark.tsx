import styles from "./Wordmark.module.css";

// The one place the display serif is used in the app chrome: the wordmark.
export function Wordmark({ size = "md" }: { size?: "md" | "lg" }) {
  return (
    <span className={`${styles.mark} ${size === "lg" ? styles.lg : ""}`} aria-label="boardofserv">
      boardofserv
    </span>
  );
}
