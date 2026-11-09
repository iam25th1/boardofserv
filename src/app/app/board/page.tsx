"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { createScope, createTimeline, stagger, svg, utils } from "animejs";
import { TopBar, TopLink } from "@/components/chat/TopBar";
import { SearchIcon } from "@/components/icons";
import { Button } from "@/components/ui";
import { formatAmount } from "@/lib/money";
import { REDUCED_MOTION, ease } from "@/lib/motion";
import { fetchBoard } from "@/lib/publicApi";
import type { PublicHelperDTO } from "@/lib/types";
import styles from "./board.module.css";

// The board: every published helper as a short chalk card, newest first,
// with a search by name. Anyone can browse; using a helper needs sign-in.
//
// One orchestrated entrance: the first time the board loads, the cards are
// chalked on (each wipes in as if drawn left to right, then its underline is
// drawn) in a quick stagger. Nothing else here moves on its own, and reduced
// motion shows the board as it is.

export default function BoardPage() {
  const [helpers, setHelpers] = useState<PublicHelperDTO[] | null>(null);
  const [query, setQuery] = useState("");
  const [failed, setFailed] = useState(false);
  // Flips once, when the first load has cards to chalk on.
  const [entrance, setEntrance] = useState(false);
  const grid = useRef<HTMLUListElement>(null);
  const first = useRef(true);

  const load = useCallback(async (q: string, signal?: AbortSignal) => {
    try {
      const list = await fetchBoard(q, signal);
      setHelpers(list);
      setFailed(false);
      if (first.current) {
        first.current = false;
        if (list.length) setEntrance(true);
      }
    } catch {
      if (!signal?.aborted) setFailed(true);
    }
  }, []);

  // A search waits for a short pause in typing; a newer one cancels the last.
  useEffect(() => {
    const ctl = new AbortController();
    const timer = setTimeout(() => void load(query, ctl.signal), first.current ? 0 : 200);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [query, load]);

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

  return (
    <div className={styles.page}>
      <TopBar agents={<TopLink href="/app/chat">Your agents</TopLink>} here="board" />
      <main className={styles.col}>
        <header className={styles.head}>
          <h1>The board</h1>
          <p className={styles.note}>helpers people made, free to try</p>
        </header>

        <label className={styles.search}>
          <SearchIcon size={16} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name" aria-label="Search helpers by name" type="search" />
        </label>

        {failed ? (
          <div className={styles.empty}>
            <p>The board could not load.</p>
            <Button variant="ghost" size="sm" onClick={() => void load(query)}>
              Try again
            </Button>
          </div>
        ) : helpers === null ? (
          <p className={styles.loading}>getting the board</p>
        ) : helpers.length === 0 ? (
          <div className={styles.empty}>
            {query.trim() ? (
              <p>Nothing on the board matches that.</p>
            ) : (
              <>
                <p>Nothing on the board yet.</p>
                <Link href="/app/chat">Describe a helper and publish it</Link>
              </>
            )}
          </div>
        ) : (
          <ul className={styles.grid} ref={grid}>
            {helpers.map((h) => (
              <li key={h.slug}>
                <Link href={`/h/${h.slug}`} className={styles.card} data-card>
                  <strong>{h.name}</strong>
                  <svg className={`${styles.line} chalky`} viewBox="0 0 96 6" aria-hidden="true" focusable="false" data-line>
                    <path d="M2 4c18-3 34 1 50-1s28-1 42-2" />
                  </svg>
                  <p>{h.description}</p>
                  <small>@{h.maker}</small>
                  {h.prices.length > 0 && (
                    <small className={styles.price}>
                      {h.prices.map((p) => `${formatAmount(BigInt(p.amount), p.decimals)} ${p.currency}`).join(" or ")} a use
                    </small>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
