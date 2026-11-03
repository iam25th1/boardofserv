import "server-only";
import { create } from "qrcode";

// A QR code as one SVG path in a size x size grid of unit squares, drawn on
// the server so the browser gets plain markup it can colour with the chalk
// tokens.
export function qrPath(text: string): { size: number; d: string } {
  const { modules } = create(text, { errorCorrectionLevel: "M" });
  const parts: string[] = [];
  for (let y = 0; y < modules.size; y++) {
    for (let x = 0; x < modules.size; x++) if (modules.get(y, x)) parts.push(`M${x} ${y}h1v1h-1z`);
  }
  return { size: modules.size, d: parts.join("") };
}
