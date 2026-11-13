import "server-only";
import type { User } from "../db/schema";
import { modelConfig } from "../model";
import { servKeyOf } from "../servKey";
import { servOnly, type BuildContext } from "./build";

// Who a build or a test run is for: the maker, their conversation, and SERV
// on their own key when they have one (else the site's). Null when SERV
// isn't set up at all.
export function buildContext(user: User, conversationId: string | null): BuildContext | null {
  const config = modelConfig(process.env, { servKey: servKeyOf(user) });
  const serv = servOnly(config);
  if (!serv.providers.length) return null;
  return { userId: user.id, conversationId, ownKey: Boolean(config.ownKey), serv, timeZone: user.timezone };
}

export const NOT_AVAILABLE = "Building agents isn't available right now. Try again in a few minutes.";
