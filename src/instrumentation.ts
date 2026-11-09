// Next.js calls register() once as each server starts. Payments and the
// agents' job worker boot in the Node runtime only. The check stays in this
// shape so the edge bundle drops the imports (and the database driver
// behind them) at build time.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { bootPayments } = await import("./lib/payments/boot");
    await bootPayments();
    const { bootJobs } = await import("./lib/agents/runtime/boot");
    bootJobs();
  }
}
