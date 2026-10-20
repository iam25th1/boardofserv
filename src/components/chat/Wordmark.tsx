import styles from "./Wordmark.module.css";

// The strokes of the chalk logo mark: a little board with a wave on it.
export function LogoStrokes() {
  return (
    <>
      <rect x="2" y="4" width="22" height="16" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M7 15c2-4 4-4 6 0s4 4 6 0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M9 23h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </>
  );
}

// The chalk logo mark and the product name,
// set in Onest bold. The mark goes through the rough filter so it reads as
// chalk; the name stays crisp so it reads as type.
export function Wordmark({ size = "md", nameless = false }: { size?: "md" | "lg"; nameless?: boolean }) {
  return (
    <span className={`${styles.mark} ${size === "lg" ? styles.lg : ""}`} aria-label="boardofserv" role="img">
      <svg viewBox="0 0 26 26" className={`${styles.logo} chalky`} aria-hidden="true" focusable="false">
        <LogoStrokes />
      </svg>
      {!nameless && (
        <span className={styles.name} aria-hidden="true">
          boardofserv
        </span>
      )}
    </span>
  );
}
