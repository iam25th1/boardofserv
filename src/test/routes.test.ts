import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

  it("puts every app page in the one shell, the market's included", () => {
    expect(readFileSync(join(APP, "app/layout.tsx"), "utf8")).toMatch(/<AppShell>/);
    expect(readFileSync(join(APP, "h/layout.tsx"), "utf8")).toMatch(/<AppShell>/);
    const pages: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(dir, e.name));
        else if (e.name === "page.tsx") pages.push(join(dir, e.name).slice(APP.length + 1));
      }
    };
    walk(join(APP, "app"));
    for (const page of ["app/board/agents/[id]/page.tsx", "app/rentals/page.tsx", "app/rentals/[id]/page.tsx", "app/rentals/[id]/setup/page.tsx", "app/agents/[id]/dashboard/page.tsx", "app/requests/page.tsx", "app/requests/[id]/page.tsx"]) {
      expect(pages, page).toContain(page);
    }
    // No page brings a top bar of its own.
    for (const page of pages) expect(readFileSync(join(APP, page), "utf8"), page).not.toMatch(/TopBar/);
  });
});
