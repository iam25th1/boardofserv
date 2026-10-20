import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { palette, type PaletteToken, type ThemeName } from "./palette";

// tokens.css is the source of every colour. palette.ts mirrors the solid ones
// for code that needs a literal. This test reads both and fails on any drift.

const css = readFileSync(join(__dirname, "tokens.css"), "utf8");

function block(selector: string): string {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`tokens.css has no block for ${selector}`);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

function read(body: string, token: PaletteToken): string | undefined {
  return new RegExp(`--${token}:\\s*(#[0-9a-f]{6})`, "i").exec(body)?.[1]?.toLowerCase();
}

const blocks: Record<ThemeName, string[]> = {
  dark: [block(":root {")],
  light: [block(':root:not([data-theme="dark"])'), block(':root[data-theme="light"]')],
};

describe("palette.ts mirrors tokens.css", () => {
  for (const theme of ["dark", "light"] as const) {
    for (const token of Object.keys(palette[theme]) as PaletteToken[]) {
      it(`${theme} ${token}`, () => {
        for (const body of blocks[theme]) expect(read(body, token)).toBe(palette[theme][token]);
      });
    }
  }
});
