import { z } from "zod";

// Every reply ends with a sketch of the agent so far, in one block on its own
// lines (the system prompt asks for it):
//
//   <<<SKETCH
//   {"name": ..., "kind": ..., "watches": ..., "when": ..., "how": ..., "tells": ..., "asking": ..., "choices": [...]}
//   SKETCH>>>
//
// The server streams the text before the block as the reply and cuts the
// block out, so the person never sees it. A missing or invalid block leaves
// the reply as it is and the stored sketch untouched.

export const SKETCH_OPEN = "<<<SKETCH";
export const SKETCH_CLOSE = "SKETCH>>>";

export const SKETCH_KINDS = ["watcher", "digest", "helper"] as const;
export const SKETCH_FIELDS = ["watches", "when", "how", "tells"] as const;
export type SketchKind = (typeof SKETCH_KINDS)[number];
export type SketchFieldKey = (typeof SKETCH_FIELDS)[number];

// How many characters at the end of `text` could still be the start of the
// opening marker. Those are held back until the next chunk decides.
function partialMarker(text: string): number {
  for (let n = Math.min(SKETCH_OPEN.length - 1, text.length); n > 0; n--) {
    if (SKETCH_OPEN.startsWith(text.slice(-n))) return n;
  }
  return 0;
}

// Splits a streamed reply into the text to show and the sketch block. push()
// returns what is safe to show now; anything that might be the start of the
// marker waits, so a half marker never reaches the screen.
export class SketchSplitter {
  private held = "";
  private block: string | null = null;

  get inBlock(): boolean {
    return this.block !== null;
  }

  push(text: string): string {
    if (this.block !== null) {
      this.block += text;
      return "";
    }
    const buf = this.held + text;
    const at = buf.indexOf(SKETCH_OPEN);
    if (at !== -1) {
      this.held = "";
      this.block = buf.slice(at + SKETCH_OPEN.length);
      return buf.slice(0, at);
    }
    const keep = partialMarker(buf);
    this.held = buf.slice(buf.length - keep);
    return buf.slice(0, buf.length - keep);
  }

  // At the end of the stream: `rest` is held text that turned out not to be a
  // marker, `raw` is the block's content (null when there was none). Text
  // after the closing marker is dropped.
  finish(): { rest: string; raw: string | null } {
    if (this.block === null) return { rest: this.held, raw: null };
    const end = this.block.indexOf(SKETCH_CLOSE);
    return { rest: "", raw: end === -1 ? this.block : this.block.slice(0, end) };
  }
}

// Short plain words, null when unknown. The model sometimes writes "null" as
// a string or leaves a field out; both mean unknown. Long values are cut.
function words(max: number) {
  return z.preprocess((v) => {
    if (v === undefined || v === null) return null;
    if (typeof v !== "string") return v;
    const t = v.trim();
    return t === "" || t.toLowerCase() === "null" ? null : t.slice(0, max);
  }, z.string().nullable());
}

// One of a fixed set, or null for anything else.
function oneOf<T extends readonly [string, ...string[]]>(values: T) {
  return z.preprocess((v) => {
    const t = typeof v === "string" ? v.trim().toLowerCase() : null;
    return t && (values as readonly string[]).includes(t) ? t : null;
  }, z.enum(values).nullable());
}

const SketchBlock = z.object({
  name: words(60),
  kind: oneOf(SKETCH_KINDS),
  watches: words(80),
  when: words(80),
  how: words(80),
  tells: words(80),
  asking: oneOf(SKETCH_FIELDS),
  choices: z.preprocess(
    (v) =>
      Array.isArray(v)
        ? [...new Set(v.filter((c): c is string => typeof c === "string").map((c) => c.trim().slice(0, 60)))].filter(Boolean).slice(0, 4)
        : [],
    z.array(z.string()),
  ),
});

export type ParsedSketch = z.infer<typeof SketchBlock>;

// The block's content as a sketch, or null when it is missing or invalid.
export function parseSketchBlock(raw: string | null): ParsedSketch | null {
  if (raw === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw.trim());
  } catch {
    return null;
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const parsed = SketchBlock.safeParse(json);
  return parsed.success ? parsed.data : null;
}
