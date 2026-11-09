"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { createScope, createTimeline, stagger, svg, utils } from "animejs";
import { SearchIcon } from "@/components/icons";
import { Button, SkeletonCards } from "@/components/ui";
import { Page } from "@/components/shell/Page";
import { formatAmount } from "@/lib/money";
import { REDUCED_MOTION, ease } from "@/lib/motion";
import type { BoardQuery } from "@/lib/publicApi";
import type { AgentListingDTO, PublicHelperDTO } from "@/lib/types";
import styles from "./Board.module.css";

// The board: agents to rent and helpers to try, newest and most rented
// first, with a search and, beside them on a wide screen (above them on a
// phone), filters: what to show, what an agent connects to, and its weekly
// price. Anyone can browse; renting and using need sign-in.
//
// One orchestrated entrance: the first time the board loads, the cards are
// chalked on (each wipes in as if drawn left to right, then its underline
// is drawn) in a quick stagger. Nothing else here moves on its own, and
// reduced motion shows the board as it is.

export type BoardLoader = (q: BoardQuery, signal?: AbortSignal) => Promise<{ helpers: PublicHelperDTO[]; agents: AgentListingDTO[] }>;

const CONNECT_WORDS: Record<AgentListingDTO["connects"][number], string> = { telegram: "Telegram", sheets: "Google Sheets", web: "The web" };

export const price = (minor: string, decimals: number) => `${formatAmount(BigInt(minor), decimals)} USDC`;

export function BoardView({ load }: { load: BoardLoader }) {
  const [board, setBoard] = useState<{ helpers: PublicHelperDTO[]; agents: AgentListingDTO[] } | null>(null);
  const [query, setQuery] = useState<BoardQuery>({ q: "", kind: "all", connects: [], min: "", max: "" });
  const [failed, setFailed] = useState(false);
  // Flips once, when the first load has cards to chalk on.
  const [entrance, setEntrance] = useState(false);
  const grid = useRef<HTMLDivElement>(null);
  const first = useRef(true);

  const fetchIt = useCallback(
    async (q: BoardQuery, signal?: AbortSignal) => {
      try {
        const got = await load(q, signal);
        setBoard(got);
        setFailed(false);
        if (first.current) {
          first.current = false;
          if (got.helpers.length + got.agents.length) setEntrance(true);
        }
      } catch {
        if (!signal?.aborted) setFailed(true);
      }
    },
    [load],
  );

  // A change waits for a short pause in typing; a newer one cancels the last.
  useEffect(() => {
    const ctl = new AbortController();
    const timer = setTimeout(() => void fetchIt(query, ctl.signal), first.current ? 0 : 200);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [query, fetchIt]);

  useLayoutEffect(() => {
    if (!entrance || !grid.current) return;
    const scope = createScope({ root: grid, mediaQueries: { reduce: REDUCED_MOTION } }).add((self) => {
      if (self?.matches.reduce) return;
      const lines = svg.createDrawable("[data-line] path", 0, 0);
      utils.set("[data-card]", { opacity: 0 });
      createTimeline({ defaults: { ease: ease.draw } })
        .add(
          "[data-card]",
          { opacity: { from: 0, to: 1 }, clipPath: { from: "inset(0% 100% 0% 0%)", to: "inset(0% 0% 0% 0%)" }, duration: 420, delay: stagger(55) },
          0,
        )
        .add(lines, { draw: ["0 0", "0 1"], duration: 360, delay: stagger(55) }, 220);
    });
    return () => scope.revert();
  }, [entrance]);

  const set = (patch: Partial<BoardQuery>) => setQuery((q) => ({ ...q, ...patch }));
  const filtering = query.kind !== "all" || Boolean(query.connects?.length) || Boolean(query.min?.trim()) || Boolean(query.max?.trim());
  const empty = board && board.helpers.length + board.agents.length === 0;

  return (
    <Page title="The board" note="agents to rent, helpers to try" width="wide" aside={<Filters query={query} set={set} clear={() => set({ kind: "all", connects: [], min: "", max: "" })} filtering={filtering} />}>
      <label className={styles.search}>
        <SearchIcon size={16} />
        <input value={query.q} onChange={(e) => set({ q: e.target.value })} placeholder="Search by name or what it does" aria-label="Search the board" type="search" />
      </label>

      {failed ? (
        <div className={styles.empty}>
          <p>The board could not load.</p>
          <Button variant="ghost" size="sm" onClick={() => void fetchIt(query)}>
            Try again
          </Button>
        </div>
      ) : board === null ? (
        <SkeletonCards label="Getting the board" />
      ) : empty ? (
        <div className={styles.empty}>
          {query.q?.trim() || filtering ? (
            <p>Nothing on the board matches that.</p>
          ) : (
            <>
              <p>Nothing on the board yet.</p>
              <Link href="/app/chat">Describe an agent or a helper and publish it</Link>
            </>
          )}
        </div>
      ) : (
        <div className={styles.sections} ref={grid}>
          {board.agents.length > 0 && (
            <section aria-labelledby="board-agents">
              <h2 id="board-agents" className={styles.sectionHead}>
                Agents to rent
              </h2>
              <ul className={styles.grid}>
                {board.agents.map((a) => (
                  <li key={a.id}>
                    <AgentCard agent={a} />
                  </li>
                ))}
              </ul>
            </section>
          )}
          {board.helpers.length > 0 && (
            <section aria-labelledby="board-helpers">
              <h2 id="board-helpers" className={styles.sectionHead}>
                Helpers to try
              </h2>
              <ul className={styles.grid}>
                {board.helpers.map((h) => (
                  <li key={h.slug}>
                    <HelperCard helper={h} />
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </Page>
  );
}

function Underline() {
  return (
    <svg className={`${styles.line} chalky`} viewBox="0 0 96 6" aria-hidden="true" focusable="false" data-line>
      <path d="M2 4c18-3 34 1 50-1s28-1 42-2" />
    </svg>
  );
}

export function AgentCard({ agent: a }: { agent: AgentListingDTO }) {
  const free = BigInt(a.weeklyPrice) === 0n;
  return (
    <Link href={`/app/board/agents/${a.id}`} className={styles.card} data-card data-kind="agent">
      <div className={styles.cardHead}>
        <strong>{a.name}</strong>
        <span className={styles.price}>{free ? "free to rent" : `${price(a.weeklyPrice, a.decimals)} a week`}</span>
      </div>
      <Underline />
      <p>{a.does}</p>
      {a.connects.length > 0 && (
        <ul className={styles.connects} aria-label="Connects to">
          {a.connects.map((c) => (
            <li key={c}>{CONNECT_WORDS[c]}</li>
          ))}
        </ul>
      )}
      <div className={styles.cardFoot}>
        <small>@{a.maker}</small>
        <small>{a.renters === 1 ? "1 renting" : `${a.renters} renting`}</small>
        {BigInt(a.jobFee) > 0n && <small>+ {price(a.jobFee, a.decimals)} a job</small>}
        <small>model calls about {price(a.modelEstimate, a.decimals)} a week</small>
      </div>
      <small className={styles.trust}>{a.quality === null ? "not enough reviewed jobs yet" : null}</small>
    </Link>
  );
}

function HelperCard({ helper: h }: { helper: PublicHelperDTO }) {
  return (
    <Link href={`/h/${h.slug}`} className={styles.card} data-card data-kind="helper">
      <strong>{h.name}</strong>
      <Underline />
      <p>{h.description}</p>
      <div className={styles.cardFoot}>
        <small>@{h.maker}</small>
        {h.prices.length > 0 ? (
          <small className={styles.price}>{h.prices.map((p) => `${formatAmount(BigInt(p.amount), p.decimals)} ${p.currency}`).join(" or ")} a use</small>
        ) : (
          <small>free to try</small>
        )}
      </div>
    </Link>
  );
}

function Filters({ query, set, clear, filtering }: { query: BoardQuery; set: (p: Partial<BoardQuery>) => void; clear: () => void; filtering: boolean }) {
  const toggle = (c: AgentListingDTO["connects"][number]) => set({ connects: query.connects?.includes(c) ? query.connects.filter((x) => x !== c) : [...(query.connects ?? []), c] });
  return (
    <div className={styles.filters}>
      <fieldset>
        <legend>Show</legend>
        <div className={styles.segments} role="radiogroup" aria-label="Show">
          {(["all", "agents", "helpers"] as const).map((k) => (
            <label key={k} data-on={query.kind === k ? "true" : undefined}>
              <input type="radio" name="kind" value={k} checked={query.kind === k} onChange={() => set({ kind: k })} />
              {k === "all" ? "Both" : k === "agents" ? "Agents" : "Helpers"}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend>Connects to</legend>
        {(["telegram", "sheets", "web"] as const).map((c) => (
          <label key={c} className={styles.check}>
            <input type="checkbox" checked={Boolean(query.connects?.includes(c))} onChange={() => toggle(c)} />
            {CONNECT_WORDS[c]}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>Weekly price, USDC</legend>
        <div className={styles.range}>
          <input type="number" min={0} step="any" inputMode="decimal" placeholder="from" aria-label="Weekly price from" value={query.min} onChange={(e) => set({ min: e.target.value })} />
          <span aria-hidden="true">to</span>
          <input type="number" min={0} step="any" inputMode="decimal" placeholder="up to" aria-label="Weekly price up to" value={query.max} onChange={(e) => set({ max: e.target.value })} />
        </div>
      </fieldset>
      {filtering && (
        <Button variant="ghost" size="sm" onClick={clear}>
          Clear the filters
        </Button>
      )}
      <p className={styles.hint}>Connections and prices are about agents: helpers show when nothing narrows the board.</p>
    </div>
  );
}
