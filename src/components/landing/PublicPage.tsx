import { PublicFooter, PublicHeader } from "./PublicChrome";
import styles from "./Landing.module.css";

// A public page of words (about, using the beta, your data, support): the
// front page's top and footer around one readable column.
export function PublicPage({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className={styles.page}>
      <PublicHeader />
      <main className={styles.prose}>
        <h1>{title}</h1>
        {children}
      </main>
      <PublicFooter />
    </div>
  );
}
