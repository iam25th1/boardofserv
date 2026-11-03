// Next.js calls register() once as each server starts. Payments boot in the
// Node runtime only. The check stays in this shape so the edge bundle drops
// the import (and the database driver behind it) at build time.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { bootPayments } = await import("./lib/payments/boot");
    await bootPayments();
  }
}
