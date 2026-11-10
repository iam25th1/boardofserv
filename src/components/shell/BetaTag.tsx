import styles from "./BetaTag.module.css";

// The small chalk tag beside the mark while boardofserv is a beta: it runs
// on test money and things change.
export function BetaTag() {
  return (
    <span className={styles.tag} title="A beta: payments use test USDC on Base Sepolia, and things change.">
      beta
    </span>
  );
}
