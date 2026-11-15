import type { MetadataRoute } from "next";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { boardAgentIds } from "@/lib/market/listings";
import { SITE_URL } from "@/lib/shareMeta";

// /sitemap.xml: the public pages, and every agent on the board as it is
// when asked (so never built ahead). When the database can't answer, or
// takes too long, the sitemap has the public pages alone.

export const dynamic = "force-dynamic";

const PUBLIC_PAGES = ["/", "/everything", "/about", "/app/board", "/support", "/terms", "/privacy", "/login"];

const BOARD_WAIT_MS = 3000;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const agents = await onTheBoard();
  return [...PUBLIC_PAGES.map((path) => ({ url: `${SITE_URL}${path}` })), ...agents.map((a) => ({ url: `${SITE_URL}/app/board/agents/${a.id}`, lastModified: a.updatedAt }))];
}

async function onTheBoard(): Promise<{ id: string; updatedAt: Date }[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("The board took too long")), BOARD_WAIT_MS)));
    return await Promise.race([boardAgentIds(serverRuntime()), late]);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
