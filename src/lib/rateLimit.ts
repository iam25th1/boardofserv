// A limit on how often one address may call a public route: a fixed
// window per address and route group, kept in this process's memory (the
// app runs as one process). Over it, a 429 with Retry-After. Signed-in
// routes have their own per-account limits; these guard what anyone can
// reach without signing in.

export type LimitGroup = "read" | "health" | "webhook" | "callback" | "page" | "demo";

// Calls a minute, per address.
export const LIMITS: Record<LimitGroup, number> = {
  // The board, agents' and helpers' pages, requests, payments settings.
  read: 120,
  health: 60,
  // Telegram can send bursts; its secret is checked too.
  webhook: 600,
  // Google sending someone back after consent.
  callback: 30,
  // The examples' supplier page.
  page: 120,
  demo: 30,
};

const WINDOW_MS = 60_000;
const buckets = new Map<string, { count: number; reset: number }>();

// The caller's address: Cloudflare's own header first (the tunnel sets
// it), then the first forwarded address.
export function clientAddress(req: Request): string {
  const cf = req.headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf.slice(0, 64);
  const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (fwd) return fwd.slice(0, 64);
  return req.headers.get("x-real-ip")?.trim().slice(0, 64) || "unknown";
}

export function rateLimited(req: Request, group: LimitGroup, now = Date.now()): Response | null {
  const key = `${group}:${clientAddress(req)}`;
  let b = buckets.get(key);
  if (!b || b.reset <= now) {
    if (buckets.size > 20_000) for (const [k, v] of buckets) if (v.reset <= now) buckets.delete(k);
    b = { count: 0, reset: now + WINDOW_MS };
    buckets.set(key, b);
  }
  b.count += 1;
  if (b.count <= LIMITS[group]) return null;
  const wait = Math.max(1, Math.ceil((b.reset - now) / 1000));
  return Response.json({ error: "Too many requests. Try again in a minute." }, { status: 429, headers: { "Retry-After": String(wait) } });
}

// For tests: start every window afresh.
export function resetRateLimits(): void {
  buckets.clear();
}
