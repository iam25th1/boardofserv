"use client";
import { useCallback, useEffect, useId, useState } from "react";
import Link from "next/link";
import { Button, SkeletonCards, TextInput, Textarea } from "@/components/ui";
import { Page } from "@/components/shell/Page";
import { useStaggerIn } from "@/lib/useStaggerIn";
import type { RequestDTO } from "@/lib/types";
import { price } from "./BoardView";
import styles from "./Requests.module.css";

// The request board: what people want an agent for, most wanted first (or
// newest), each with its "me too" count chalked up as tally marks, what it
// should connect to, what they'd pay a week and how many makers offered
// one. Beside it (above it on a phone): asking for one.

export type Sort = "wanted" | "newest";
export interface AskBody {
  need: string;
  detail: string;
  connects: string[];
  budget: string;
}
export interface RequestsApi {
  load: (sort: Sort) => Promise<RequestDTO[]>;
  // Signed in: asking, and "me too". Signed out, where to sign in.
  ask?: (body: AskBody) => Promise<{ id: string }>;
  meToo?: (id: string, on: boolean) => Promise<unknown>;
  onAsked?: (id: string) => void;
  signIn?: string;
}

export const CONNECT_WORDS = { telegram: "Telegram", sheets: "Google Sheets", web: "The web" } as const;

export function RequestsView({ api }: { api: RequestsApi }) {
  const [sort, setSort] = useState<Sort>("wanted");
  const [list, setList] = useState<RequestDTO[] | null>(null);
  const [failed, setFailed] = useState(false);
  const ref = useStaggerIn<HTMLUListElement>(Boolean(list?.length));
  const load = useCallback(() => api.load(sort).then(setList, () => setFailed(true)), [api, sort]);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Page title="Requests" note="agents people want built" width="wide" aside={<Ask api={api} />}>
      <div className={styles.sort} role="radiogroup" aria-label="Sort">
        {(["wanted", "newest"] as const).map((k) => (
          <label key={k} data-on={sort === k ? "true" : undefined}>
            <input type="radio" name="sort" value={k} checked={sort === k} onChange={() => setSort(k)} />
            {k === "wanted" ? "Most wanted" : "Newest"}
          </label>
        ))}
      </div>
      {failed ? (
        <p className={styles.quiet}>The requests could not load. Try again in a moment.</p>
      ) : list === null ? (
        <SkeletonCards label="Getting the requests" count={3} />
      ) : list.length === 0 ? (
        <div className={styles.empty}>
          <p>No requests yet. Ask for the agent you wish existed: makers read this board.</p>
        </div>
      ) : (
        <ul className={styles.list} ref={ref}>
          {list.map((r) => (
            <li key={r.id} data-enter>
              <RequestCard r={r} api={api} onChange={load} />
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}

// Tally marks: four strokes and a strike through each five, up to fifteen.
export function Tally({ n }: { n: number }) {
  const shown = Math.min(n, 15);
  const groups = Math.ceil(shown / 5);
  return (
    <svg className={`${styles.tally} chalky`} viewBox={`0 0 ${Math.max(1, groups) * 30} 24`} width={Math.max(1, groups) * 30} height={24} aria-hidden="true" focusable="false">
      {Array.from({ length: groups }, (_, g) => {
        const inGroup = Math.min(5, shown - g * 5);
        const x0 = g * 30 + 3;
        return (
          <g key={g}>
            {Array.from({ length: Math.min(4, inGroup) }, (_, i) => (
              <path key={i} d={`M${x0 + i * 5 + (i % 2)} 4 L${x0 + i * 5} 21`} />
            ))}
            {inGroup === 5 && <path d={`M${x0 - 3} 17 L${x0 + 19} 7`} />}
          </g>
        );
      })}
    </svg>
  );
}

export function MeToo({ r, onToggle, signIn }: { r: RequestDTO; onToggle?: (on: boolean) => Promise<unknown>; signIn?: string }) {
  const [busy, setBusy] = useState(false);
  const count = `${r.meToo} ${r.meToo === 1 ? "wants" : "want"} it too`;
  return (
    <div className={styles.meToo}>
      <Tally n={r.meToo} />
      <span className={styles.count}>{count}</span>
      {r.mine || r.status !== "open" ? null : onToggle ? (
        <Button
          size="sm"
          variant={r.votedByMe ? "primary" : "ghost"}
          aria-pressed={r.votedByMe}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onToggle(!r.votedByMe);
            } finally {
              setBusy(false);
            }
          }}
        >
          Me too
        </Button>
      ) : signIn ? (
        <Link className={styles.small} href={signIn}>
          Sign in to say me too
        </Link>
      ) : null}
    </div>
  );
}

function RequestCard({ r, api, onChange }: { r: RequestDTO; api: RequestsApi; onChange: () => Promise<unknown> }) {
  return (
    <article className={styles.card} aria-labelledby={`req-${r.id}`}>
      <Link id={`req-${r.id}`} href={`/app/requests/${r.id}`} className={styles.need}>
        {r.need}
      </Link>
      {r.detail && <p className={styles.detail}>{r.detail}</p>}
      <div className={styles.meta}>
        {r.connects.length > 0 && (
          <ul className={styles.connects} aria-label="Connects to">
            {r.connects.map((c) => (
              <li key={c}>{CONNECT_WORDS[c]}</li>
            ))}
          </ul>
        )}
        <span>{r.budget === null ? "no budget given" : `up to ${price(r.budget, r.decimals)} a week`}</span>
      </div>
      <div className={styles.foot}>
        <MeToo r={r} onToggle={api.meToo ? (on) => api.meToo!(r.id, on).then(onChange) : undefined} signIn={api.signIn} />
        <span className={styles.small}>
          @{r.by}
          {r.mine ? " (you)" : ""}, {r.offers === 0 ? "no offers yet" : r.offers === 1 ? "1 offer" : `${r.offers} offers`}
        </span>
      </div>
    </article>
  );
}

function Ask({ api }: { api: RequestsApi }) {
  const [body, setBody] = useState<AskBody>({ need: "", detail: "", connects: [], budget: "" });
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const needId = useId();
  const detailId = useId();
  const budgetId = useId();
  if (!api.ask) {
    return (
      <div className={styles.ask}>
        <h2>Ask for an agent</h2>
        <p className={styles.quiet}>Say what it should do, and makers can offer one they built.</p>
        {api.signIn && <Link href={api.signIn}>Sign in to ask</Link>}
      </div>
    );
  }
  const send = async () => {
    setBusy(true);
    setSaid(null);
    try {
      const { id } = await api.ask!(body);
      setBody({ need: "", detail: "", connects: [], budget: "" });
      setSaid({ text: "It's on the board." });
      api.onAsked?.(id);
    } catch (err) {
      setSaid({ text: err instanceof Error ? err.message : "It couldn't be posted. Try again.", bad: true });
    } finally {
      setBusy(false);
    }
  };
  const toggle = (c: string) => setBody((b) => ({ ...b, connects: b.connects.includes(c) ? b.connects.filter((x) => x !== c) : [...b.connects, c] }));
  return (
    <form
      className={styles.ask}
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <h2>Ask for an agent</h2>
      <label htmlFor={needId}>What should it do?</label>
      <TextInput id={needId} value={body.need} maxLength={140} placeholder="Remind customers about unpaid invoices" onChange={(e) => setBody({ ...body, need: e.target.value })} required />
      <label htmlFor={detailId}>Details (optional)</label>
      <Textarea id={detailId} rows={3} value={body.detail} maxLength={1200} onChange={(e) => setBody({ ...body, detail: e.target.value })} />
      <fieldset className={styles.fieldset}>
        <legend>It should connect to</legend>
        {(["telegram", "sheets", "web"] as const).map((c) => (
          <label key={c} className={styles.check}>
            <input type="checkbox" checked={body.connects.includes(c)} onChange={() => toggle(c)} />
            {CONNECT_WORDS[c]}
          </label>
        ))}
      </fieldset>
      <label htmlFor={budgetId}>
        You&apos;d pay up to, a week<span className="visually-hidden">, in USDC</span>
      </label>
      <span className={styles.money}>
        <TextInput id={budgetId} inputMode="decimal" placeholder="say nothing" value={body.budget} onChange={(e) => setBody({ ...body, budget: e.target.value })} />
        <span aria-hidden="true">USDC</span>
      </span>
      <Button type="submit" disabled={busy || !body.need.trim()}>
        {busy ? "Posting..." : "Post the request"}
      </Button>
      {said && (
        <p className={styles.said} role={said.bad ? "alert" : "status"}>
          {said.text}
        </p>
      )}
    </form>
  );
}
