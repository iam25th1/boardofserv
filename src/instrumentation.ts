// Next.js calls register() once as each server starts. Payments boot in the
// Node runtime only.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { bootPayments } = await import("./lib/payments/boot");
  bootPayments();
}
