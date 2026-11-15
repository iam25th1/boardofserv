// Renders the app's icons with Playwright's Chromium (the browser the e2e
// tests already use), so each is drawn as a browser draws the SVG:
// - src/app/favicon.ico: src/app/icon.svg at 32 and 16 pixels.
// - src/app/apple-icon.png: 180 by 180, the mark on slate with room around
//   it (the phone rounds the corners itself).
// - public/brand/icon-192.png and icon-512.png: the mark on a rounded slate
//   tile, for the web manifest.
// - public/brand/icon-maskable-512.png: full slate, the mark well inside the
//   safe circle (the middle 80%) that any launcher's mask keeps.
// The big ones use the header's own mark (components/chat/Wordmark.tsx),
// crisp, without the chalk filter; the colours are the dark theme's slate
// and chalk (src/design/palette.ts).
//
// Run: node scripts/render-icons.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const ROOT = join(import.meta.dirname, "..");
const SLATE = "#1d201f";
const CHALK = "#e9eae4";

// The header's mark, in its 26 by 26 box. With its strokes it spans
// x 1.1 to 24.9 and y 3.1 to 23.9.
const MARK = `<g fill="none" stroke="${CHALK}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <rect x="2" y="4" width="22" height="16" rx="2" />
  <path d="M7 15c2-4 4-4 6 0s4 4 6 0" />
  <path d="M9 23h8" />
</g>`;

// The mark centred on a size-pixel square, `width` of it wide: on a tile
// with rounded corners, or on full slate.
function bigIcon(size, { width, rounded }) {
  const scale = (size * width) / 23.8;
  const x = size / 2 - 13 * scale;
  const y = size / 2 - 13.5 * scale;
  const tile = rounded ? `<rect width="${size}" height="${size}" rx="${size * 0.22}" fill="${SLATE}" />` : `<rect width="${size}" height="${size}" fill="${SLATE}" />`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${tile}<g transform="translate(${x} ${y}) scale(${scale})">${MARK}</g></svg>`;
}

// An .ico of PNG images (any browser since 2007 reads them), largest first.
function ico(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(({ size, png }, i) => {
    const at = 6 + 16 * i;
    head.writeUInt8(size % 256, at);
    head.writeUInt8(size % 256, at + 1);
    head.writeUInt16LE(1, at + 4);
    head.writeUInt16LE(32, at + 6);
    head.writeUInt32LE(png.length, at + 8);
    head.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([head, ...pngs.map((p) => p.png)]);
}

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });

async function render(svg, size) {
  await page.setViewportSize({ width: size, height: size });
  const sized = svg.replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`);
  await page.setContent(`<!doctype html><html><body style="margin:0">${sized.replace("<svg ", '<svg style="display:block" ')}</body></html>`);
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}

const small = readFileSync(join(ROOT, "src/app/icon.svg"), "utf8");
writeFileSync(join(ROOT, "src/app/favicon.ico"), ico([{ size: 32, png: await render(small, 32) }, { size: 16, png: await render(small, 16) }]));
writeFileSync(join(ROOT, "src/app/apple-icon.png"), await render(bigIcon(180, { width: 0.58, rounded: false }), 180));
writeFileSync(join(ROOT, "public/brand/icon-192.png"), await render(bigIcon(192, { width: 0.62, rounded: true }), 192));
writeFileSync(join(ROOT, "public/brand/icon-512.png"), await render(bigIcon(512, { width: 0.62, rounded: true }), 512));
writeFileSync(join(ROOT, "public/brand/icon-maskable-512.png"), await render(bigIcon(512, { width: 0.5, rounded: false }), 512));

await browser.close();
