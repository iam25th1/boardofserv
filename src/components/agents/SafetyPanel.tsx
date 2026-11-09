"use client";
import { useEffect, useId, useState } from "react";
import { Button, TextInput } from "@/components/ui";
import type { SafetyDTO } from "@/lib/types";
import styles from "./SafetyPanel.module.css";

// What an agent the renter runs may do on its own, by risk level: looks
// things up, changes their own data, sends a message, spends money. Each
// level is drawn as a stack of chalk bars, one more for each step up. The
// renter can make any tool that changes or sends something ask them first,
// and set how much it may spend per call without asking. The platform's
// floor is said beside each tool and can't be switched off.

export interface PolicyBody {
  askFor: string[];
  autoSpendUsdc: number;
}

const LEVEL = { read: 1, write: 2, outbound: 3, money: 4 } as const;
const LEVEL_WORDS = { read: "Looks things up", write: "Changes your own data", outbound: "Sends a message", money: "Spends money" } as const;

export function LevelMark({ risk }: { risk: keyof typeof LEVEL }) {
  const n = LEVEL[risk];
  return (
    <svg className={`${styles.mark} chalky`} viewBox="0 0 22 16" aria-hidden="true" focusable="false">
      {[0, 1, 2, 3].map((i) => (
        <rect key={i} x={1 + i * 5.5} y={12 - i * 3.5} width={3.5} height={3 + i * 3.5} rx={1} data-on={i < n ? "true" : undefined} />
      ))}
    </svg>
  );
}

export function SafetyPanel({ safety, save, disabled }: { safety: SafetyDTO; save: (body: PolicyBody) => Promise<unknown>; disabled?: boolean }) {
  const [asks, setAsks] = useState(() => new Set(safety.tools.filter((t) => t.asks).map((t) => t.tool)));
  const [auto, setAuto] = useState(String(safety.autoSpendUsdc));
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const autoId = useId();
  useEffect(() => {
    setAsks(new Set(safety.tools.filter((t) => t.asks).map((t) => t.tool)));
    setAuto(String(safety.autoSpendUsdc));
  }, [safety]);
  const spends = safety.tools.some((t) => t.risk === "money");

  const send = async () => {
    const n = auto.trim() === "" ? 0 : Number(auto);
    if (!Number.isFinite(n) || n < 0 || n > safety.maxAutoSpendUsdc) {
      setSaid({ text: `Write an auto limit from 0 to ${safety.maxAutoSpendUsdc} USDC.`, bad: true });
      return;
    }
    setBusy(true);
    setSaid(null);
    try {
      await save({ askFor: [...asks], autoSpendUsdc: n });
      setSaid({ text: "Saved. It applies from its next action." });
    } catch (err) {
      setSaid({ text: err instanceof Error ? err.message : "That didn't save. Try again.", bad: true });
    } finally {
      setBusy(false);
    }
  };

  const levels = (["read", "write", "outbound", "money"] as const).filter((r) => safety.tools.some((t) => t.risk === r));
  return (
    <section className={styles.panel} aria-labelledby="safety-h">
      <h2 id="safety-h">On its own, or ask you first</h2>
      <p className={styles.quiet}>Before anything that changes, sends or spends, a safety check reads it against what this agent is for. You can also make it ask you every time.</p>
      <ol className={styles.levels}>
        {levels.map((r) => (
          <li key={r} data-risk={r}>
            <div className={styles.levelHead}>
              <LevelMark risk={r} />
              <strong>{LEVEL_WORDS[r]}</strong>
            </div>
            <ul className={styles.tools}>
              {safety.tools
                .filter((t) => t.risk === r)
                .map((t) => (
                  <li key={t.tool}>
                    <div className={styles.tool}>
                      <span>{t.does}</span>
                      {t.floor && <span className={styles.floor}>{t.floor}</span>}
                    </div>
                    {t.canRaise ? (
                      <label className={styles.switch}>
                        <input
                          type="checkbox"
                          checked={asks.has(t.tool)}
                          disabled={disabled || busy}
                          onChange={(e) => {
                            const next = new Set(asks);
                            if (e.target.checked) next.add(t.tool);
                            else next.delete(t.tool);
                            setAsks(next);
                          }}
                        />
                        <span>Ask me first</span>
                      </label>
                    ) : (
                      <span className={styles.fixed}>{t.risk === "read" ? "on its own" : "always asks"}</span>
                    )}
                  </li>
                ))}
            </ul>
          </li>
        ))}
      </ol>
      {spends && (
        <div className={styles.auto}>
          <label htmlFor={autoId}>
            Spend without asking, per payment or order<span className="visually-hidden">, in USDC</span>
          </label>
          <span className={styles.money}>
            <TextInput id={autoId} inputMode="decimal" value={auto} onChange={(e) => setAuto(e.target.value)} disabled={disabled || busy} />
            <span aria-hidden="true">USDC</span>
          </span>
          <p className={styles.quiet}>Anything over it waits for your yes. 0 means it asks before every spend.</p>
        </div>
      )}
      <div className={styles.row}>
        <Button size="sm" onClick={() => void send()} disabled={disabled || busy}>
          {busy ? "Saving..." : "Save"}
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
