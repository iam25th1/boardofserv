import { describe, it, expect } from "vitest";
import { contrastRatio } from "../../lib/contrast";
import { palette, type PaletteToken } from "../../design/palette";

// WCAG AA for normal text is a ratio of at least 4.5. The palettes come from
// src/design/palette.ts, which a test keeps in step with tokens.css. If a pair
// fails, the token should be fixed, not the threshold.
//
// chalk-3 is the quiet hint ink (placeholders, timestamps, the small labels in
// the sketch dock). Like the old "faint" token it sits below AA on purpose and
// is never the only carrier of meaning, so it is not listed here.

const AA_NORMAL = 4.5;

const pairs: Array<[PaletteToken, PaletteToken]> = [
  ["chalk", "slate"],
  ["chalk", "slate-2"],
  ["chalk", "slate-3"],
  ["chalk-2", "slate"],
  ["chalk-2", "slate-2"],
  ["chalk-2", "slate-3"],
  // Primary buttons and the send button: slate ink on a chalk fill.
  ["slate", "chalk"],
];

describe("contrastRatio", () => {
  it("returns 21 for black on white", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
  });

  it("returns 1 for identical colours", () => {
    expect(contrastRatio("#12685c", "#12685c")).toBeCloseTo(1, 5);
  });

  it("handles shorthand #rgb notation", () => {
    expect(contrastRatio("#fff", "#000")).toBeCloseTo(21, 1);
  });
});

for (const theme of ["dark", "light"] as const) {
  describe(`${theme} theme text pairs meet WCAG AA`, () => {
    for (const [fg, bg] of pairs) {
      it(`${fg} on ${bg}`, () => {
        const ratio = contrastRatio(palette[theme][fg], palette[theme][bg]);
        expect(ratio, `${theme} ${fg}/${bg} ratio ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(AA_NORMAL);
      });
    }
  });
}
