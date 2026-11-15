import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/shareMeta";

// /robots.txt: the public pages are open to crawlers; the API and the
// signed-in app under /app/ are not, except the board and its agents'
// pages, which anyone can read. (The longer rule wins, so /app/board
// beats /app/.)
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: ["/", "/app/board"], disallow: ["/api/", "/app/"] },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
