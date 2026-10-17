import { describe, it, expect } from "vitest";
import { contrastRatio } from "../../lib/contrast";

// WCAG AA for normal text is a ratio of at least 4.5. These palettes mirror the
// values in src/design/tokens.css. If a pair fails, the token should be fixed,
// not the threshold.

const AA_NORMAL = 4.5;

const light = {
  paper: "#f6f7f6",
  surface: "#ffffff",
  "surface-2": "#f1f3f2",
  ink: "#16211e",
  muted: "#5b6b66",
  faint: "#8a9a94",
  accent: "#12685c",
  "accent-strong": "#0e554b",
  "accent-soft": "#e6f0ed",
  "on-accent": "#ffffff",
  warning: "#9a5a00",
  "warning-soft": "#fbefd9",
  danger: "#a5342f",
  "danger-soft": "#f7e3e1",
  hairline: "#e2e6e3",
} as const;

const dark = {
  paper: "#0e1513",
  surface: "#15201c",
  "surface-2": "#1c2a25",
  ink: "#e8eeeb",
  muted: "#9db0a9",
  faint: "#6f837c",
  accent: "#3fb8a3",
  "accent-strong": "#5ccbb7",
  "accent-soft": "#16302a",
  "on-accent": "#07110e",
  warning: "#e0a24a",
  "warning-soft": "#2a2113",
  danger: "#e08585",
  "danger-soft": "#2a1716",
  hairline: "#273630",
} as const;

const lightPairs: Array<[keyof typeof light, keyof typeof light]> = [
  ["ink", "paper"],
  ["ink", "surface"],
  ["ink", "surface-2"],
  ["muted", "paper"],
  ["muted", "surface"],
  ["on-accent", "accent"],
  ["on-accent", "accent-strong"],
  ["warning", "warning-soft"],
  ["danger", "danger-soft"],
  ["accent", "surface"],
  ["accent-strong", "paper"],
];

const darkPairs: Array<[keyof typeof dark, keyof typeof dark]> = [
  ["ink", "paper"],
  ["ink", "surface"],
  ["ink", "surface-2"],
  ["muted", "paper"],
  ["muted", "surface"],
  ["on-accent", "accent"],
  ["on-accent", "accent-strong"],
  ["warning", "warning-soft"],
  ["danger", "danger-soft"],
  ["accent", "surface"],
  ["accent", "paper"],
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

describe("light theme text pairs meet WCAG AA", () => {
  for (const [fg, bg] of lightPairs) {
    it(`${fg} on ${bg}`, () => {
      const ratio = contrastRatio(light[fg], light[bg]);
      expect(ratio, `light ${fg}/${bg} ratio ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(AA_NORMAL);
    });
  }
});

describe("dark theme text pairs meet WCAG AA", () => {
  for (const [fg, bg] of darkPairs) {
    it(`${fg} on ${bg}`, () => {
      const ratio = contrastRatio(dark[fg], dark[bg]);
      expect(ratio, `dark ${fg}/${bg} ratio ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(AA_NORMAL);
    });
  }
});
