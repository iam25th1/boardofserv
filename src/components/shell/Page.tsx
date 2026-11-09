import styles from "./Page.module.css";

// A page of the app under the shell: a heading (and a handwritten note
// beside it), then the content in a column sized for what the page is.
//
// - narrow: forms and single things (a job, the wallet, connections).
// - wide: lists and dashboards, with an optional side panel (filters on
//   the board, details beside a dashboard) that sits beside the content on
//   a wide screen and above it on a phone (or below, when the content's
//   controls come first).

export function Page({
  title,
  note,
  width = "narrow",
  aside,
  asideSide = "left",
  asideNarrow = "above",
  actions,
  above,
  children,
}: {
  title?: React.ReactNode;
  note?: React.ReactNode;
  width?: "narrow" | "wide";
  aside?: React.ReactNode;
  asideSide?: "left" | "right";
  // Where the side panel goes when the screen is too narrow for it.
  asideNarrow?: "above" | "below";
  actions?: React.ReactNode;
  // Above the heading: sub-navigation for a group of pages.
  above?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <main className={styles.page} data-width={width}>
      {above}
      {(title || actions) && (
        <header className={styles.head}>
          <div className={styles.titles}>
            {title && <h1>{title}</h1>}
            {note && <p className={styles.note}>{note}</p>}
          </div>
          {actions && <div className={styles.actions}>{actions}</div>}
        </header>
      )}
      {aside ? (
        <div className={styles.split} data-side={asideSide} data-narrow={asideNarrow}>
          <aside className={styles.aside}>{aside}</aside>
          <div className={styles.content}>{children}</div>
        </div>
      ) : (
        <div className={styles.content}>{children}</div>
      )}
    </main>
  );
}
