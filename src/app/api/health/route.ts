import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { paymentsConfig } from "@/lib/payments/config";
import { rateLimited } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

// For Pier's health check and uptime monitors: ok while the server can reach
// its database, plus the payments network and whether payments are on.
// Nothing else: no address, no version, no error text.
export async function GET(req: Request = new Request("http://localhost/api/health")) {
  const limited = rateLimited(req, "health");
  if (limited) return limited;
  const config = paymentsConfig();
  const up = await databaseUp();
  return Response.json(
    { ok: up, database: up ? "up" : "down", network: config.networkLabel, payments: config.enabled ? "on" : "off" },
    { status: up ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}

const TIMEOUT_MS = 2_000;

async function databaseUp(): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      db.execute(sql`select 1`),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
