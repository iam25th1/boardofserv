// The platform's minimum interval between an agent's runs, in minutes
// (AGENT_MIN_INTERVAL_MINUTES, 15 by default, never under 1): no schedule
// or value check runs more often, whatever its plan or its renter says.
export const DEFAULT_MIN_INTERVAL_MINUTES = 15;

export function minIntervalMinutes(env: Record<string, string | undefined> = typeof process === "undefined" ? {} : process.env): number {
  const n = Number(env.AGENT_MIN_INTERVAL_MINUTES);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_MIN_INTERVAL_MINUTES;
}
