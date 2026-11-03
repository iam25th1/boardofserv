import "server-only";
import { checkBinding } from "./binding";
import { bootLines, paymentsConfig, readPaymentsConfig, setPaymentsLock } from "./config";

// The config from the environment alone, before any lock.
const readUnlocked = () => readPaymentsConfig();
import { scanTick } from "./deposits";
import { sweepTick } from "./uses";
import { payoutTick } from "./withdrawals";

// Runs once when the server starts (see src/instrumentation.ts): checks the
// database belongs to this network (binding.ts), says in the log whether
// payments are on, on which network, and what is off and why (Base mainnet
// always gets a warning), then, with payments on, runs the
// payments work on an interval: the deposit watcher, the sweep that releases
// holds of uses that never ended, and payouts.
let booted = false;

const UNREACHABLE = {
  off: true,
  currencies: [],
  problems: ["The database could not be reached to check its network. Payments stay off until it can be; trying again every 30 seconds."],
};

export async function bootPayments(): Promise<void> {
  if (booted) return;
  booted = true;
  const env = paymentsConfig();
  if (!env.enabled) return log();
  if (await bindNow()) return start();
  // No database yet (the app started before it): payments stay off and the
  // check is tried again until it works.
  setPaymentsLock(UNREACHABLE);
  log();
  const retry = setInterval(() => {
    void bindNow().then((ok) => {
      if (!ok) return;
      clearInterval(retry);
      start();
    });
  }, 30_000);
  retry.unref?.();
}

async function bindNow(): Promise<boolean> {
  try {
    setPaymentsLock(await checkBinding(readUnlocked()));
    return true;
  } catch {
    return false;
  }
}

function log(): void {
  for (const line of bootLines(paymentsConfig())) {
    if (line.level === "warn") console.warn(line.text);
    else console.info(line.text);
  }
}

// With the binding checked: the boot log, then the interval.
function start(): void {
  log();
  const config = paymentsConfig();
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
