import Link from "next/link";
import { Wordmark } from "@/components/chat/Wordmark";
import styles from "./not-found.module.css";

// Any address that is not a page: same slate, same chalk.
export default function NotFound() {
  return (
    <main className={styles.page}>
      <div className={styles.col}>
        <Wordmark />
        <h1 className={styles.title}>Nothing on this board</h1>
        <p className={styles.note}>this page was wiped clean</p>
        <Link href="/app/chat" className={styles.back}>
          Back to your agents
        </Link>
      </div>
    </main>
  );
}
