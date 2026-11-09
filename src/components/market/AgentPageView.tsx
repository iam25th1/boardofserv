"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { SkeletonPanel } from "@/components/ui";
import { Page } from "@/components/shell/Page";
import { useStaggerIn } from "@/lib/useStaggerIn";
import type { AgentPageDTO } from "@/lib/types";
import { price } from "./BoardView";
import { ReportButton, type ReportSend } from "./ReportButton";
import styles from "./AgentPage.module.css";

// An agent's page on the board: what it does, the steps it takes in plain
// words (drawn as a job's timeline: a square works things out, a diamond
// decides, a circle acts), what it asks when you set it up, what it never
// does without asking you, and all it can ever do. Beside it: the price,
// who made it, how many rent it, its scores when there are enough reviewed
// jobs, and the way to rent it.

export interface AgentPageApi {
  load: (id: string) => Promise<AgentPageDTO | null>;
  // The way to rent it (a button, or why not): given the page.
  rent?: (page: AgentPageDTO) => React.ReactNode;
  // Reporting it or its maker (signed in), or where to sign in.
  report?: ReportSend;
  signIn?: string;
}

const ASK_KIND: Record<string, string> = { sheet: "a Google Sheet tab", url: "a web address", number: "a number", boolean: "yes or no", choice: "a choice", list: "a list", text: "a few words" };

export function AgentPageView({ id, api }: { id: string; api: AgentPageApi }) {
  const [page, setPage] = useState<AgentPageDTO | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    api.load(id).then(setPage, () => setFailed(true));
  }, [api, id]);
  const steps = useStaggerIn<HTMLOListElement>(Boolean(page));

  if (failed) return <Page title="This agent could not load">Try again in a moment.</Page>;
  if (page === undefined) {
    return (
      <Page width="wide">
        <SkeletonPanel label="Getting the agent" lines={8} />
      </Page>
    );
  }
  if (page === null) {
    return (
      <Page title="Not on the board" note="it may have been taken off">
        <Link href="/app/board">Back to the board</Link>
      </Page>
    );
  }
  const free = BigInt(page.weeklyPrice) === 0n;
  return (
    <Page
      title={page.name}
      note={`by @${page.maker}, version ${page.version}`}
      width="wide"
      asideSide="right"
      aside={
        <div className={styles.side}>
          <div className={styles.priceBox}>
            <p className={styles.price}>{free ? "Free to rent" : `${price(page.weeklyPrice, page.decimals)} a week`}</p>
            {BigInt(page.jobFee) > 0n && <p className={styles.fee}>plus {price(page.jobFee, page.decimals)} for each job it finishes</p>}
            <p className={styles.fee}>Its model calls cost about {price(page.modelEstimate, page.decimals)} a week</p>
            {api.rent?.(page)}
          </div>
          <dl className={styles.facts}>
            <div>
              <dt>Made by</dt>
              <dd>@{page.maker}</dd>
            </div>
            <div>
              <dt>Renting it now</dt>
              <dd>{page.renters}</dd>
            </div>
            <div>
              <dt>Quality and trust</dt>
              <dd className={styles.pending}>{page.quality === null ? "not enough reviewed jobs yet" : page.quality}</dd>
            </div>
          </dl>
          {!page.mine && (
            <div className={styles.reports}>
              <ReportButton kind="agent" targetId={page.id} send={api.report} signIn={api.signIn} />
              <ReportButton kind="maker" targetId={page.id} send={api.report} signIn={api.signIn} label={`Report @${page.maker}`} />
            </div>
          )}
        </div>
      }
    >
      <p className={styles.lede}>{page.does}</p>
      <p className={styles.done}>
        <span>Done when</span> {page.done}
      </p>
      <ul className={styles.runs}>
        {page.runs.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>

      <section aria-labelledby="steps-h" className={styles.block}>
        <h2 id="steps-h">The steps it takes</h2>
        <ol className={styles.steps} ref={steps}>
          {page.steps.map((s, i) => (
            <li key={i} data-enter data-kind={s.kind}>
              <svg className={`${styles.mark} chalky`} viewBox="0 0 24 24" aria-hidden="true">
                {s.kind === "works" ? <rect x="4" y="4" width="16" height="16" rx="2" /> : s.kind === "decides" ? <path d="M12 1 L23 12 L12 23 L1 12 Z" /> : <circle cx="12" cy="12" r="9" />}
              </svg>
              <div>
                <span className={styles.stepKind}>{s.kind === "works" ? "works out" : s.kind === "decides" ? "decides" : "does"}</span>
                <strong>{s.title}</strong>
                {s.outcomes.length > 0 && <span className={styles.outcomes}>{s.outcomes.join(", or ")}</span>}
              </div>
            </li>
          ))}
        </ol>
      </section>

      {page.asks.length > 0 && (
        <section aria-labelledby="asks-h" className={styles.block}>
          <h2 id="asks-h">What it asks when you set it up</h2>
          <ul className={styles.list}>
            {page.asks.map((a) => (
              <li key={a.label}>
                <strong>{a.label}</strong> <span className={styles.kind}>({ASK_KIND[a.kind] ?? a.kind})</span>
                <span className={styles.help}>{a.help}</span>
              </li>
            ))}
            {page.needs.telegram && (
              <li>
                <strong>Your Telegram</strong>, linked once on Connections
              </li>
            )}
            {page.needs.google && (
              <li>
                <strong>Your Google account</strong>, connected once; it reaches only the sheet tabs you pick
              </li>
            )}
          </ul>
        </section>
      )}

      <section aria-labelledby="never-h" className={styles.block}>
        <h2 id="never-h">It never does these without asking you</h2>
        {page.neverWithoutAsking.length ? (
          <ul className={styles.list}>
            {page.neverWithoutAsking.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        ) : (
          <p className={styles.help}>It has no spending limits or questions of its own; it can only do what is listed below.</p>
        )}
      </section>

      <section aria-labelledby="only-h" className={styles.block}>
        <h2 id="only-h">All it can ever do</h2>
        <ul className={styles.list}>
          {page.canOnly.map((c) => (
            <li key={c}>{c}</li>
          ))}
          {(page.connects.includes("sheets") || page.connects.includes("web")) && (
            <li className={styles.help}>
              Besides reading{" "}
              {[page.connects.includes("sheets") ? "the sheet tabs you give it" : null, page.connects.includes("web") ? "public web pages and web searches" : null].filter(Boolean).join(", and ")}.
            </li>
          )}
        </ul>
      </section>
    </Page>
  );
}
