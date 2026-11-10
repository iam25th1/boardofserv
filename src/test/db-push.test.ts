// @vitest-environment node
import { describe, expect, it } from "vitest";
import { pushVerdict } from "../../scripts/db-push";

// What drizzle-kit push printed in a deploy's environment (stdin closed, no
// terminal), captured from real runs against a scratch database.
const NOTHING = "[✓] Pulling schema from database...\n[i] No changes detected\n";
const APPLIED = "[✓] Pulling schema from database...\n[✓] Changes applied\n";
const DATA_LOSS = [
  "[✓] Pulling schema from database...",
  " Warning  Found data-loss statements:",
  "· You're about to delete extra_newer table with 1 items",
  "THIS ACTION WILL CAUSE DATA LOSS AND CANNOT BE REVERTED",
  "Do you still want to push changes?",
  "❯ No, abort",
  "  Yes, I want to remove 1 table,",
].join("\n");
const RENAME = "Is helper_notes table created or renamed from another table?\n❯ + helper_notes          create table\n  ~ helper_note › helper_notes rename table\n";
// drizzle-kit 0.31 with no terminal, captured against a throwaway Postgres
// in phase 9: it can't ask, says so, changes nothing, and still exits 0.
const TTY = "Error: Interactive prompts require a TTY terminal (process.stdin.isTTY or process.stdout.isTTY is false). This can happen when running in CI, piped input, or non-interactive shells.\n    at render10 (node_modules/drizzle-kit/bin.cjs:1450:31)";
const DATA_LOSS_031 = ["[✓] Pulling schema from database...", " Warning  Found data-loss statements:", "· You're about to delete b column in zz_probe table with 1 items", "THIS ACTION WILL CAUSE DATA LOSS AND CANNOT BE REVERTED", "Do you still want to push changes?", TTY].join("\n");
const RENAME_031 = `[✓] Pulling schema from database...\n${TTY}\n    at promptNamedWithSchemasConflict (node_modules/drizzle-kit/bin.cjs:32812:65)`;

describe("the deploy's schema push", () => {
  it("passes when the schema is applied or already matches", () => {
    expect(pushVerdict(0, NOTHING)).toEqual({ ok: true });
    expect(pushVerdict(0, APPLIED)).toEqual({ ok: true });
  });

  it("fails the deploy when drizzle-kit stopped at a question, though it exited 0", () => {
    for (const out of [DATA_LOSS, RENAME]) {
      const v = pushVerdict(0, out);
      expect(v.ok).toBe(false);
      expect(!v.ok && v.reason).toContain("by hand");
    }
  });

  it("fails the deploy when drizzle-kit 0.31 says it can't ask, whatever it exits with", () => {
    for (const out of [DATA_LOSS_031, RENAME_031]) {
      for (const status of [0, 1]) {
        const v = pushVerdict(status, out);
        expect(v.ok).toBe(false);
        expect(!v.ok && v.reason).toContain("by hand");
      }
    }
  });

  it("fails on a non-zero exit, or when it never says the schema was applied", () => {
    expect(pushVerdict(1, APPLIED).ok).toBe(false);
    expect(pushVerdict(null, "").ok).toBe(false);
    expect(pushVerdict(0, "[✓] Pulling schema from database...\n").ok).toBe(false);
  });
});
