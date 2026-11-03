import "server-only";
import { bootLines, paymentsConfig } from "./config";

// Runs once when the server starts (see src/instrumentation.ts): says in the
// log whether payments are on, on which network, and what is off and why.
// Base mainnet always gets a warning.
let booted = false;

export function bootPayments(): void {
  if (booted) return;
  booted = true;
  for (const line of bootLines(paymentsConfig())) {
    if (line.level === "warn") console.warn(line.text);
    else console.info(line.text);
  }
}
