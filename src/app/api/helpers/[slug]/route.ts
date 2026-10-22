import { and, eq, isNull } from "drizzle-orm";
import { getUserFromRequest } from "@/lib/auth-route";
import { db } from "@/lib/db";
import { publishedHelpers } from "@/lib/db/schema";
import { helperPage } from "@/lib/helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A helper's page, for anyone: the public helper, or that it was taken down.
export async function GET(_req: Request, { params }: { params: { slug: string } }) {
  const page = await helperPage(params.slug);
  if (!page) return Response.json({ error: "Not found" }, { status: 404 });
  if ("takenDown" in page) return Response.json({ error: "This helper was taken down.", name: page.takenDown }, { status: 410 });
  return Response.json(page);
}

// The maker takes their helper off the board. The row stays, so the slug is
// not reused and the helper's page says it was taken down.
export async function DELETE(req: Request, { params }: { params: { slug: string } }) {
  const user = await getUserFromRequest(req);
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const owned = await db.query.publishedHelpers.findFirst({
    columns: { id: true },
    where: and(eq(publishedHelpers.slug, params.slug), eq(publishedHelpers.ownerUserId, user.id)),
  });
  if (!owned) return Response.json({ error: "Not found" }, { status: 404 });
  await db
    .update(publishedHelpers)
    .set({ unpublishedAt: new Date() })
    .where(and(eq(publishedHelpers.id, owned.id), isNull(publishedHelpers.unpublishedAt)));
  return Response.json({ ok: true });
}
