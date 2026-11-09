import { PublicFooter, PublicHeader } from "./PublicChrome";
import styles from "./Landing.module.css";

// A public page of words (about, terms, privacy, support): the front
// page's top and footer around one readable column.
export function PublicPage({ title, draft, updated, children }: { title: string; draft?: boolean; updated?: string; children: React.ReactNode }) {
  return (
    <div className={styles.page}>
      <PublicHeader />
      <main className={styles.prose}>
        {draft && (
          <p className={styles.draft} role="note">
            Draft: written in plain language for the owner of boardofserv to review before it is final. It is not legal advice and may change.
          </p>
        )}
        <h1>{title}</h1>
        {updated && <p className={styles.updated}>{updated}</p>}
        {children}
      </main>
      <PublicFooter />
    </div>
  );
}

// A blank the owner fills in, said plainly.
export function Fill({ children }: { children: React.ReactNode }) {
  return <span className={styles.fill}>{children}</span>;
}
