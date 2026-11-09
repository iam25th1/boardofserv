"use client";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { animate } from "animejs";
import { Button, TextInput } from "@/components/ui";
import { formatAmount, parseAmount } from "@/lib/money";
import { REDUCED_MOTION, ease } from "@/lib/motion";
import type { BudgetDTO } from "@/lib/types";
import styles from "./BudgetPanel.module.css";

// An installation's model cost this week against its weekly budget, drawn
// as a chalk bar that fills to what is spent. The renter sets the budget
// within the platform's ceiling, or goes back to the maker's default. A
// free agent runs on the platform's weekly allowance; an agent whose maker
// passes on model cost charges each job's cost on top of the fee.

const usdc = (minor: string | bigint, d = 6) => `${formatAmount(BigInt(minor), d)} USDC`;

export function BudgetPanel({ budget, save, disabled }: { budget: BudgetDTO; save: (modelBudget: string | null) => Promise<unknown>; disabled?: boolean }) {
  const [text, setText] = useState(() => formatAmount(BigInt(budget.budget), budget.decimals));
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const id = useId();
  const fill = useRef<HTMLSpanElement>(null);
  useEffect(() => setText(formatAmount(BigInt(budget.budget), budget.decimals)), [budget.budget, budget.decimals]);

  const cap = BigInt(budget.free ? (BigInt(budget.allowance) < BigInt(budget.budget) ? budget.allowance : budget.budget) : budget.budget);
  const spent = BigInt(budget.spentThisWeek);
  const share = cap === 0n ? 1 : Math.min(1, Number((spent * 10_000n) / cap) / 10_000);

  useLayoutEffect(() => {
    const el = fill.current;
    if (!el || window.matchMedia(REDUCED_MOTION).matches) return;
    const a = animate(el, { scaleX: { from: 0, to: 1 }, duration: 600, ease: ease.draw });
    return () => {
      a.revert();
    };
  }, [share]);

  const send = async (value: string | null) => {
    let minor: bigint | null = null;
    if (value !== null) {
      minor = parseAmount(value, budget.decimals);
      if (minor === null || minor > BigInt(budget.ceiling)) {
        setSaid({ text: `Write a budget from 0 to ${usdc(budget.ceiling, budget.decimals)} a week.`, bad: true });
        return;
      }
    }
    setBusy(true);
    setSaid(null);
    try {
      await save(minor === null ? null : minor.toString());
      setSaid({ text: value === null ? "Back to the maker's default." : "Saved. It applies from its next model call." });
    } catch (err) {
      setSaid({ text: err instanceof Error ? err.message : "That didn't save. Try again.", bad: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.panel} aria-labelledby="budget-h">
      <h2 id="budget-h">Model budget</h2>
      <div className={styles.meter} role="img" aria-label={`${usdc(spent, budget.decimals)} of ${usdc(cap, budget.decimals)} spent this week`}>
        <span className={styles.track} />
        <span className={styles.fill} ref={fill} style={{ width: `${share * 100}%` }} />
      </div>
      <dl className={styles.facts}>
        <div>
          <dt>This week</dt>
          <dd>
            {usdc(spent, budget.decimals)} of {usdc(cap, budget.decimals)}
          </dd>
        </div>
        <div>
          <dt>Today</dt>
          <dd>{usdc(budget.spentToday, budget.decimals)}</dd>
        </div>
        <div>
          <dt>Its maker&apos;s default</dt>
          <dd>{usdc(budget.makerDefault, budget.decimals)} a week</dd>
        </div>
      </dl>
      <p className={styles.quiet}>
        Its decisions and safety checks are model calls. Before one would take it over this week&apos;s budget, it asks you.
        {budget.free ? ` It is free, so boardofserv pays up to ${usdc(budget.allowance, budget.decimals)} a week of it; after that it pauses until Monday.` : ""}
        {budget.modelShare ? " Each job's model cost is added to what you pay for it." : ""}
      </p>
      <div className={styles.set}>
        <label htmlFor={id}>
          Weekly budget<span className="visually-hidden">, in USDC</span>
        </label>
        <span className={styles.money}>
          <TextInput id={id} inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} disabled={disabled || busy} />
          <span aria-hidden="true">USDC</span>
        </span>
        <span className={styles.quiet}>at most {usdc(budget.ceiling, budget.decimals)}</span>
      </div>
      <div className={styles.row}>
        <Button size="sm" onClick={() => void send(text)} disabled={disabled || busy}>
          {busy ? "Saving..." : "Save the budget"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void send(null)} disabled={disabled || busy}>
          Use the maker&apos;s default
        </Button>
        {said && (
          <span className={styles.said} data-bad={said.bad ? "true" : undefined} role={said.bad ? "alert" : "status"}>
            {said.text}
          </span>
        )}
      </div>
    </section>
  );
}
