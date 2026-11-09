import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { agentInstallations } from "../../db/schema";
import { ALLOWANCE_PREFIX, budgetOf, callEstimate, weekCost } from "../metering";
import type { Runtime } from "./context";
import { control, loadInstallation } from "./installations";

// The worker's cycle: free agents paused because their weekly allowance was
// used up start again once a new week has begun.
export async function resumeAllowances(rt: Runtime): Promise<number> {
  const paused = await rt.db
    .select()
    .from(agentInstallations)
    .where(and(eq(agentInstallations.status, "paused"), sql`${agentInstallations.pausedReason} like ${`${ALLOWANCE_PREFIX}%`}`));
  let resumed = 0;
  for (const i of paused) {
    if ((await weekCost(rt, i.id)).site + callEstimate() > (await budgetOf(rt, i)).allowance) continue;
    const l = await loadInstallation(rt, i.id);
    if (!l) continue;
    await control(rt, l, "resume").catch(() => undefined);
    resumed += 1;
  }
  return resumed;
}
