// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { palette } from "@/design/palette";

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
