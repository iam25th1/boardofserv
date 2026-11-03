"use client";
import { useId } from "react";
import { TextInput } from "@/components/ui";
import { formatAmount, parseAmount } from "@/lib/money";
import type { CurrencyDTO, PriceDTO } from "@/lib/types";
import styles from "./PriceFields.module.css";

// A price per use for each currency payments take, typed as a decimal
// ("0.25"). Empty or 0 means that currency isn't accepted; with no price at
// all the helper stays free to try, with the daily limit.

export type PriceDrafts = Partial<Record<CurrencyDTO["code"], string>>;

// The drafts a helper's current prices start from.
export function draftsOf(prices: PriceDTO[]): PriceDrafts {
  return Object.fromEntries(prices.map((p) => [p.currency, formatAmount(BigInt(p.amount), p.decimals, 0)]));
}

// The prices to send (minor units, null to stop accepting one), or why the
// drafts can't be sent.
export function readPrices(drafts: PriceDrafts, currencies: CurrencyDTO[]): { prices: Partial<Record<CurrencyDTO["code"], string | null>>; problem: string | null } {
  const prices: Partial<Record<CurrencyDTO["code"], string | null>> = {};
  for (const c of currencies) {
    const text = (drafts[c.code] ?? "").trim();
    if (!text) {
      prices[c.code] = null;
      continue;
    }
    const units = parseAmount(text, c.decimals);
    if (units === null) return { prices, problem: `Write the ${c.code} price as a number, like 0.25, with at most ${c.decimals} decimals.` };
    prices[c.code] = units === 0n ? null : units.toString();
  }
  return { prices, problem: null };
}

export function PriceFields({
  currencies,
  drafts,
  onChange,
  disabled,
  problem,
}: {
  currencies: CurrencyDTO[];
  drafts: PriceDrafts;
  onChange: (next: PriceDrafts) => void;
  disabled?: boolean;
  problem: string | null;
}) {
  const id = useId();
  if (currencies.length === 0) return null;
  return (
    <fieldset className={styles.fields} disabled={disabled}>
      <legend>Price per use</legend>
      <div className={styles.row}>
        {currencies.map((c) => (
          <label key={c.code} className={styles.price}>
            <TextInput
              value={drafts[c.code] ?? ""}
              onChange={(e) => onChange({ ...drafts, [c.code]: e.target.value })}
              inputMode="decimal"
              placeholder="free"
              aria-label={`Price per use in ${c.code}`}
              aria-describedby={`${id}-note`}
              aria-invalid={problem ? true : undefined}
            />
            <span aria-hidden="true">{c.code}</span>
          </label>
        ))}
      </div>
      <small id={`${id}-note`}>Empty means free in that currency. You get 90% of each paid use; boardofserv keeps 10%.</small>
      {problem && (
        <p className={styles.problem} role="alert">
          {problem}
        </p>
      )}
    </fieldset>
  );
}
