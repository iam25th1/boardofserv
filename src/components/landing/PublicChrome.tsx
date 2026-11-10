import Link from "next/link";
import { Wordmark } from "@/components/chat/Wordmark";
import { ThemeToggle } from "@/components/chat/ThemeToggle";
import { OpenApp } from "./OpenApp";
import { BetaTag } from "@/components/shell/BetaTag";
import styles from "./Landing.module.css";

// The public pages' top and bottom: the mark with its beta tag, the board,
// about and support, the way into the app; and the footer's way to the
// whole explainer above its plain links.

export function PublicHeader() {
  return (
    <header className={styles.top}>
      <span className={styles.brand}>
        <Link href="/" className={styles.home} aria-label="boardofserv, the front page">
          <Wordmark />
        </Link>
        <BetaTag />
      </span>
      <nav aria-label="boardofserv" className={styles.topNav}>
        <Link href="/app/board">Board</Link>
        <Link href="/about">About</Link>
        <Link href="/support">Support</Link>
      </nav>
      <div className={styles.topEnd}>
        <ThemeToggle />
        <OpenApp quiet small />
      </div>
    </header>
  );
}

// `here` marks the explainer's own page, where the button points at itself.
export function PublicFooter({ here }: { here?: string }) {
  return (
    <footer className={styles.footer}>
      <div className={styles.footerMark}>
        <Wordmark />
        <p>Small agents for one job each, made by people, rented by the week.</p>
      </div>
      <div className={styles.footerEnd}>
        <Link href="/everything" className={styles.guide} aria-current={here === "/everything" ? "page" : undefined}>
          Everything you need to know
        </Link>
        <nav aria-label="More" className={styles.footerNav}>
          <ul>
            <li>
              <Link href="/app/board">The board</Link>
            </li>
            <li>
              <Link href="/app/chat">Make an agent</Link>
            </li>
            <li>
              <Link href="/about">About</Link>
            </li>
            <li>
              <Link href="/support">Support</Link>
            </li>
            <li>
              <Link href="/terms">Using the beta</Link>
            </li>
            <li>
              <Link href="/privacy">Your data</Link>
            </li>
          </ul>
        </nav>
      </div>
    </footer>
  );
}
