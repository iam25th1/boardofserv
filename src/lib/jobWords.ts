import type { JobSummaryDTO } from "./types";

// How a job stands, in words, for its card and its page: a done job may
// have skipped for empty input or finished with a note.
const JOB_WORD: Record<JobSummaryDTO["status"], string> = {
  queued: "waiting to start",
  running: "running",
  waiting_for_owner: "waiting for you",
  done: "done",
  failed: "failed",
  cancelled: "stopped",
};

export function jobWord(j: Pick<JobSummaryDTO, "status" | "outcome">): string {
  if (j.status === "done" && j.outcome === "skipped") return "skipped, empty input";
  if (j.status === "done" && j.outcome === "noted") return "done, with a note";
  return JOB_WORD[j.status];
}
