import "server-only";
import { bootLines, paymentsConfig } from "./config";
import { scanTick } from "./deposits";
import { sweepTick } from "./uses";
import { payoutTick } from "./withdrawals";

// Runs once when the server starts (see src/instrumentation.ts): says in the
// log whether payments are on, on which network, and what is off and why
// (Base mainnet always gets a warning), then, with payments on, runs the
// payments work on an interval: the deposit watcher, the sweep that releases
// holds of uses that never ended, and payouts.
let booted = false;

export function bootPayments(): void {
  if (booted) return;
  booted = true;
  const config = paymentsConfig();
  for (const line of bootLines(config)) {
    if (line.level === "warn") console.warn(line.text);
    else console.info(line.text);
  }
  if (!config.enabled || process.env.BOS_PAYMENTS_WORKER === "0") return;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await paymentsTick();
    } finally {
      busy = false;
    }
  };
  setTimeout(() => void tick(), 3_000).unref?.();
  setInterval(() => void tick(), config.scanIntervalMs).unref?.();
}

// One round of the payments work. Each part logs its own failures.
export async function paymentsTick(): Promise<void> {
  await scanTick();
  await sweepTick();
  await payoutTick();
}
