import type { AgentSketch } from "./agentSketch";
import type { SketchDTO } from "./types";

// Development fixture only: the ETH watcher from the chalk mockup. Loaded with
// a dynamic import inside a development-only branch, so production builds
// never contain it. ?sketch=demo shows it waiting on one answer; ?sketch=ready
// shows it ready, so the switch can be tried.

const none = { value: "", status: "empty" as const };

export const ethWatcher: AgentSketch = {
  name: "ETH floor watch",
  kind: "watcher",
  watches: { value: "ETH price in USD", status: "set" },
  when: { value: "Below $2,000", status: "set" },
  how: { value: "Every 5 minutes", status: "set" },
  tells: { value: "", status: "waiting" },
  takes: none,
  does: none,
  gives: none,
  cost: "About **0.4 credit a day** while ETH stays above the line.",
  live: false,
};

export const ethWatcherReady: AgentSketch = {
  ...ethWatcher,
  tells: { value: "Telegram", status: "set" },
};

// The same agent as the server stores it, for the /demo harness's
// sketch=live: the dock on real data, with no switch to flip and no cost.
export const ethWatcherStored: SketchDTO = {
  name: "ETH floor watch",
  kind: "watcher",
  watches: "ETH price in USD",
  when: "Below $2,000",
  how: "Every 5 minutes",
  tells: null,
  takes: null,
  does: null,
  gives: null,
  asking: "tells",
  live: false,
};

// An answer helper as the server stores it, for the /demo harness's
// sketch=answer (waiting on what it gives back) and sketch=answer-ready.
export const blurbHelperStored: SketchDTO = {
  name: "Shop blurb writer",
  kind: "answer",
  watches: null,
  when: null,
  how: null,
  tells: null,
  takes: "A product name and a few facts",
  does: "Writes a friendly two line shop blurb",
  gives: null,
  asking: "gives",
  live: false,
};

