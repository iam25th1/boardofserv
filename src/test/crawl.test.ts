// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { palette } from "@/design/palette";
import manifest from "@/app/manifest";
import robots from "@/app/robots";

// What browsers and crawlers ask for besides the pages: the icons, the web
// manifest, robots.txt and the sitemap with the board's agents.

const ROOT = process.cwd();
const png = (path: string) => readFileSync(join(ROOT, path));
const sizeOf = (file: Buffer) => [file.readUInt32BE(16), file.readUInt32BE(20)];

describe("the icons", () => {
  it("draw the mark in the dark theme's chalk on its slate", () => {
    const svg = readFileSync(join(ROOT, "src/app/icon.svg"), "utf8");
    expect(svg).toContain(`fill="${palette.dark.slate}"`);
    expect(svg).toContain(`stroke="${palette.dark.chalk}"`);
    expect(svg).toMatch(/viewBox="0 0 32 32"/);
  });

  it("have a 32 by 32 favicon.ico, with a 16 by 16 beside it", () => {
    const ico = png("src/app/favicon.ico");
    expect([ico.readUInt16LE(0), ico.readUInt16LE(2)]).toEqual([0, 1]);
    const entries = Array.from({ length: ico.readUInt16LE(4) }, (_, i) => {
      const at = 6 + 16 * i;
      const image = ico.subarray(ico.readUInt32LE(at + 12), ico.readUInt32LE(at + 12) + ico.readUInt32LE(at + 8));
      return { size: [ico[at], ico[at + 1]], image };
    });
    expect(entries.map((e) => e.size)).toEqual([
      [32, 32],
      [16, 16],
    ]);
    for (const e of entries) {
      expect(e.image.subarray(1, 4).toString()).toBe("PNG");
      expect(sizeOf(e.image)).toEqual(e.size);
    }
  });

  it("have a 180 by 180 apple icon with no see-through corners", () => {
    const apple = png("src/app/apple-icon.png");
    expect(sizeOf(apple)).toEqual([180, 180]);
    // Colour type 2: RGB, no alpha (a phone would fill see-through parts with black).
    expect(apple[25]).toBe(2);
  });
});

describe("the web manifest", () => {
  it("names boardofserv, describes the beta and opens the front page", () => {
    const m = manifest();
    expect(m).toMatchObject({ name: "boardofserv", short_name: "boardofserv", start_url: "/", display: "standalone", theme_color: palette.dark.slate, background_color: palette.dark.slate });
    expect(m.description).toBe("Build an agent with SERV Reasoning at its core and rent it out. Or rent one that's already working. A beta, on test USDC.");
  });

  it("lists 192 and 512 icons, and a maskable 512, each a real PNG of its size", () => {
    const icons = manifest().icons ?? [];
    expect(icons.map((i) => [i.sizes, i.purpose])).toEqual([
      ["192x192", "any"],
      ["512x512", "any"],
      ["512x512", "maskable"],
    ]);
    for (const icon of icons) {
      const file = png(join("public", icon.src));
      expect(file.subarray(1, 4).toString(), icon.src).toBe("PNG");
      expect(sizeOf(file).join("x"), icon.src).toBe(icon.sizes);
    }
    // A mask may cut anything outside the middle 80%: the maskable one is
    // full slate to its edges, and its corners are as opaque as its middle.
    expect(png("public/brand/icon-maskable-512.png")[25]).toBe(2);
  });
});

describe("robots.txt", () => {
  it("opens the public pages and the board, and closes the API and the rest of the app", () => {
    const r = robots();
    expect(r.rules).toEqual({ userAgent: "*", allow: ["/", "/app/board"], disallow: ["/api/", "/app/"] });
    expect(r.sitemap).toBe("https://boardofserv.25th.dev/sitemap.xml");
  });
});
