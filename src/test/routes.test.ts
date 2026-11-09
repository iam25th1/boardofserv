import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";

type Redirect = { source: string; destination: string; permanent: boolean };
// next.config.mjs is plain JavaScript, without types.
const config = async () => {
  // @ts-expect-error next.config.mjs is plain JavaScript, without types
  const mod = (await import("../../next.config.mjs")) as { default: { redirects: () => Promise<Redirect[]> }; MOVED_TO_APP: string[] };
  return { redirects: await mod.default.redirects(), moved: mod.MOVED_TO_APP };
};

// The app lives under /app. Every old address moves there for good (query
// strings kept by Next), and nothing an outside service calls moves at all.

const APP = join(__dirname, "../app");

describe("routes", () => {
  it("moves every old app address to /app for good", async () => {
    const { redirects, moved } = await config();
    for (const page of moved) {
      expect(existsSync(join(APP, "app", page, "page.tsx")) || existsSync(join(APP, "app", page)), page).toBe(true);
      expect(existsSync(join(APP, page)), `${page} still has a page at the top`).toBe(false);
      expect(redirects).toContainEqual({ source: `/${page}`, destination: `/app/${page}`, permanent: true });
      expect(redirects).toContainEqual({ source: `/${page}/:path*`, destination: `/app/${page}/:path*`, permanent: true });
    }
  });

  it("leaves what outside services and shared links call where it is", async () => {
    const { redirects } = await config();
    for (const kept of ["/api", "/h", "/login", "/examples", "/"]) expect(redirects.some((r) => r.source === kept || r.source.startsWith(`${kept}/`)), kept).toBe(false);
    for (const route of ["api/telegram/webhook/route.ts", "api/connections/google/callback/route.ts", "api/health/route.ts", "api/openserv/link/finish/route.ts", "h/[slug]/page.tsx", "login/page.tsx", "page.tsx"]) {
      expect(existsSync(join(APP, route)), route).toBe(true);
    }
  });
});
