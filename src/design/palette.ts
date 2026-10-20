// The solid colours from tokens.css, for the few places that cannot read a CSS
// variable: the browser theme colour, Privy's accent, and the contrast test.
// tokens.css stays the source; src/design/palette.test.ts fails if these drift.

export type ThemeName = "dark" | "light";

export const palette = {
  dark: {
    slate: "#1d201f",
    "slate-2": "#242827",
    "slate-3": "#2d3230",
    chalk: "#e9eae4",
    "chalk-2": "#a8aca5",
    "chalk-3": "#6c716b",
  },
  light: {
    slate: "#f2f3f1",
    "slate-2": "#e8eae7",
    "slate-3": "#dcdfdb",
    chalk: "#1b1e1d",
    "chalk-2": "#4c524e",
    "chalk-3": "#858b86",
  },
} as const satisfies Record<ThemeName, Record<string, `#${string}`>>;

export type PaletteToken = keyof (typeof palette)["dark"];
