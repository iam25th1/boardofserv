import "server-only";
import { eq } from "drizzle-orm";
import { agentVersions, type AgentVersion, type User } from "../db/schema";
import type { Runtime } from "./runtime/context";
import { reviewVersion, type VersionReview } from "./vetting";
import { meterPlatform, platformRoom } from "./metering";

// The code review a draft goes through before it is published (or offered
// to renters as an update), kept on the version. It runs on the maker's own
// SERV key when they have one, else the site's, within the site's day
// budget and the platform's own model budget; when SERV can't review, the
// draft stays a draft.
export async function vetVersion(rt: Runtime, maker: User, version: AgentVersion): Promise<VersionReview> {
  const serv = rt.serv(maker);
  const refused = serv ? await rt.siteRefusal(maker, serv.ownKey) : "SERV isn't set up.";
  // The platform's own call: within its daily model budget, metered.
  const room = serv && !refused ? await platformRoom(rt.db, serv.ownKey, rt.now()) : false;
  const review = await reviewVersion(version.definition!, version.code, serv && !refused && room ? serv.config : null, {
    now: rt.now(),
    fetchImpl: rt.fetchImpl,
    record: async (call) => {
      await rt.record(maker, call, serv!.ownKey, "agent_vetting");
      await meterPlatform(rt.db, { purpose: "publish_review", userId: maker.id, agentId: version.agentId, call, ownKey: serv!.ownKey, now: rt.now() });
    },
  });
  await rt.db.update(agentVersions).set({ review }).where(eq(agentVersions.id, version.id));
  return review;
}

export const REVIEW_BLOCKED = "The code review found problems to fix before it can be published.";
export const REVIEW_DOWN = "The code review couldn't run just now, so it isn't published yet. Try again in a minute.";
