import { spawnSync } from "node:child_process";

// The schema push a deploy runs (pier.json: npm run db:push:deploy), where
// nobody can answer drizzle-kit's questions. drizzle-kit applies an additive
// change by itself; for anything that would lose data, or a rename it can't
// tell from a drop and an add, it asks, and with no terminal it gives up and
// changes nothing: drizzle-kit 0.28 still exited 0, 0.31 says "Interactive
// prompts require a TTY" and exits 1. The deploy would then start the new
// code on the old schema. This fails the deploy instead, before the restart,
// so the change can be made by hand first (docs/DEPLOY-PIER.md).

export type PushVerdict = { ok: true } | { ok: false; reason: string };

export function pushVerdict(status: number | null, output: string): PushVerdict {
  if (/data-loss|❯|Interactive prompts require a TTY/.test(output)) {
    return {
      ok: false,
      reason: "drizzle-kit push stopped at a question (data loss, or a rename it can't tell apart) and changed nothing. Make the change by hand, then deploy again (docs/DEPLOY-PIER.md).",
    };
  }
  if (status !== 0) return { ok: false, reason: `drizzle-kit push exited ${status ?? "on a signal"}.` };
  if (/No changes detected|Changes applied/.test(output)) return { ok: true };
  return { ok: false, reason: "drizzle-kit push did not say it applied the schema." };
}

// Run when started by npm run db:push:deploy, not when a test imports it.
if (!process.env.VITEST) {
  const r = spawnSync("drizzle-kit", ["push"], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  process.stdout.write(r.stdout ?? "");
  process.stderr.write(r.stderr ?? "");
  const verdict = pushVerdict(r.status, `${r.stdout ?? ""}${r.stderr ?? ""}`);
  if (!verdict.ok) {
    console.error(`db:push:deploy: ${verdict.reason}`);
    process.exit(1);
  }
}
