import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { getUserFromRequest } from "@/lib/auth-route";
import { db } from "@/lib/db";
import { publishedHelpers } from "@/lib/db/schema";
import { helperPage } from "@/lib/helpers";
import { PricesBody, readPrices } from "@/lib/payments/prices";
import { setPrices } from "@/lib/payments/uses";

export const runtime = "nodejs";

const Body = z.object({ prices: PricesBody });

// The maker changes what one use of their helper costs, per currency. A
// currency left out keeps its price; null or "0" stops accepting it. With no
// price left, the helper is free again, with the daily limit.
export async function PUT(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const params = await ctx.params;
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Prices are whole numbers of the currency's smallest unit." }, { status: 400 });
  const owned = await db.query.publishedHelpers.findFirst({
    columns: { id: true },
    where: and(eq(publishedHelpers.slug, params.slug), eq(publishedHelpers.ownerUserId, user.id), isNull(publishedHelpers.unpublishedAt)),
  });
  if (!owned) return Response.json({ error: "Not found" }, { status: 404 });
  const prices = readPrices(parsed.data.prices);
  if ("error" in prices) return Response.json({ error: prices.error }, { status: 400 });
  await setPrices(owned.id, prices.prices);
  const page = await helperPage(params.slug);
  return Response.json(page && "helper" in page ? page : { error: "Not found" }, { status: page && "helper" in page ? 200 : 404 });
}
