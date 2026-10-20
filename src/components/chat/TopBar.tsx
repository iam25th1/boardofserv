import { Wordmark } from "./Wordmark";
import { ThemeToggle } from "./ThemeToggle";
import styles from "./TopBar.module.css";

// The top bar over the one centred column: the chalk mark, the agents pill,
// then the theme toggle and the account menu pushed to the right.
export function TopBar({ agents, account }: { agents: React.ReactNode; account: React.ReactNode }) {
  return (
    <header className={styles.top}>
      <Wordmark />
      {agents}
      <div className={styles.end}>
        <ThemeToggle />
        {account}
      </div>
    </header>
  );
}
