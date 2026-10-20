// WCAG 2.1 contrast checker. This file is the contrast checker itself, so it is
// the one place allowed to hold literal hex values. It implements sRGB relative
// luminance and the standard contrast ratio formula.

function normalizeHex(hex: string): string {
  let h = hex.trim().toLowerCase();
  if (h.startsWith("#")) h = h.slice(1);
  if (h.length === 3) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  if (h.length !== 6 || /[^0-9a-f]/.test(h)) {
    throw new Error(`contrastRatio: invalid hex colour "${hex}"`);
  }
  return h;
}

function channelToLinear(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex: string): number {
  const h = normalizeHex(hex);
  const r = channelToLinear(parseInt(h.slice(0, 2), 16));
  const g = channelToLinear(parseInt(h.slice(2, 4), 16));
  const b = channelToLinear(parseInt(h.slice(4, 6), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Ratio of relative luminances, where 1 is identical and 21 is black on white.
export function contrastRatio(hexA: string, hexB: string): number {
  const lumA = relativeLuminance(hexA);
  const lumB = relativeLuminance(hexB);
  const lighter = Math.max(lumA, lumB);
  const darker = Math.min(lumA, lumB);
  return (lighter + 0.05) / (darker + 0.05);
}
