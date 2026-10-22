import Link from "next/link";
import { Wordmark } from "./Wordmark";
import { ThemeToggle } from "./ThemeToggle";
import styles from "./TopBar.module.css";

// The top bar over the one centred column: the chalk mark, the agents pill
// and the Board link, then the theme toggle and the account menu pushed to
// the right. Pages without the pill (the board, a helper's page) put a plain
// link to the agents in its place.
export function TopBar({ agents, account, here }: { agents: React.ReactNode; account?: React.ReactNode; here?: "board" }) {
  return (
    <header className={styles.top}>
      <Wordmark />
      {agents}
      <TopLink href="/board" current={here === "board"}>
        Board
      </TopLink>
      <div className={styles.end}>
        <ThemeToggle />
        {account}
      </div>
    </header>
  );
}

export function TopLink({ href, current, children }: { href: string; current?: boolean; children: React.ReactNode }) {
  return (
    <Link href={href} className={styles.link} aria-current={current ? "page" : undefined}>
      {children}
    </Link>
  );
}
