import { z } from "zod";
import type { SketchDTO } from "./types";

// The agent sketch as JSON (parseSketchBlock, mergeSketch), and the safety net
// that keeps a sketch out of a reply's text (SketchSplitter).
//
// Replies no longer write a sketch: a plan call before the reply reads it
// (see sketchPlan.ts). But if a reply still ends with the old block
//
//   <<<SKETCH
//   {"name": ..., "watches": ..., ...}
//   SKETCH>>>
//
// or with bare sketch JSON, the server streams only the text before it, so
// the person never sees it.

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

// Live, the model has also ended replies with the sketch's JSON and no
// markers. So a line that opens with "{" or a code fence is held back too,
// and decided at the end: a sketch is cut out, anything else is shown.
const UNMARKED = ["{", "```"];

// Where each line in `text` starts. `first` says whether index 0 does.
function lineStarts(text: string, first: boolean): number[] {
  const starts = first ? [0] : [];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

// A sketch written without markers: the JSON object from the first "{" to
// the last "}" (fences and a stray closing marker fall outside it), if it
// parses as a sketch and has at least one sketch key.
function unmarkedSketch(text: string): string | null {
  const from = text.indexOf("{");
  const to = text.lastIndexOf("}");
  if (from === -1 || to < from) return null;
  const json = text.slice(from, to + 1);
  if (!parseSketchBlock(json)) return null;
  const keys = Object.keys(JSON.parse(json) as object);
  return keys.some((k) => k === "name" || k === "kind" || k === "asking" || (SKETCH_FIELDS as readonly string[]).includes(k)) ? json : null;
}

// Splits a streamed reply into the text to show and the sketch block. push()
// returns what is safe to show now; anything that might be the start of the
// marker waits, so a half marker never reaches the screen.
export class SketchSplitter {
  private held = "";
  private block: string | null = null;
  // Holding from a line that may open an unmarked sketch, until the end.
  private maybe = false;
  // Whether the next character shown starts a line.
  private atLineStart = true;

  get inBlock(): boolean {
    return this.block !== null;
  }

  private show(text: string): string {
    if (text) this.atLineStart = text.endsWith("\n");
    return text;
  }

  push(text: string): string {
    if (this.block !== null) {
      this.block += text;
      return "";
    }
    if (this.maybe) {
      this.held += text;
      return "";
    }
    const buf = this.held + text;
    const at = buf.indexOf(SKETCH_OPEN);
    const starts = lineStarts(buf, this.atLineStart);
    const line = starts.find((i) => (at === -1 || i < at) && UNMARKED.some((u) => buf.startsWith(u, i)));
    if (line !== undefined) {
      this.maybe = true;
      this.held = buf.slice(line);
      return this.show(buf.slice(0, line));
    }
    if (at !== -1) {
      this.held = "";
      this.block = buf.slice(at + SKETCH_OPEN.length);
      return this.show(buf.slice(0, at));
    }
    // Hold a possible marker, or a line that may yet become a fence.
    const last = starts.at(-1);
    const fence = last !== undefined && last < buf.length && "```".startsWith(buf.slice(last)) ? buf.length - last : 0;
    const keep = Math.max(partialMarker(buf), fence);
    this.held = buf.slice(buf.length - keep);
    return this.show(buf.slice(0, buf.length - keep));
  }

  // At the end of the stream: `rest` is held text that turned out not to be a
  // sketch (shown after all), `raw` is the sketch's JSON (null when there was
  // none). Text after the sketch is dropped.
  finish(): { rest: string; raw: string | null } {
    if (this.block !== null) {
      const end = this.block.indexOf(SKETCH_CLOSE);
      return { rest: "", raw: end === -1 ? this.block : this.block.slice(0, end) };
    }
    if (!this.maybe) return { rest: this.held, raw: null };
    const held = this.held;
    const at = held.indexOf(SKETCH_OPEN);
    if (at !== -1) {
      const after = held.slice(at + SKETCH_OPEN.length);
      const end = after.indexOf(SKETCH_CLOSE);
      return { rest: held.slice(0, at), raw: end === -1 ? after : after.slice(0, end) };
    }
    // The last held line that opens an unmarked sketch wins; what is before
    // it (a code example, say) is shown.
    for (const i of lineStarts(held, true).reverse()) {
      if (!UNMARKED.some((u) => held.startsWith(u, i))) continue;
      const raw = unmarkedSketch(held.slice(i));
      // A fence opened just for the sketch goes with it.
      if (raw) return { rest: held.slice(0, i).replace(/```[\w-]*\n$/, ""), raw };
    }
    return { rest: held, raw: null };
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

// A reply's sketch merged into the stored one. A value from the model replaces
// the stored value (the person changed their mind); a null never wipes one.
// "asking" always comes from the latest reply. Choices are not stored.
export function mergeSketch(stored: SketchDTO | null, parsed: ParsedSketch): SketchDTO {
  return {
    name: parsed.name ?? stored?.name ?? null,
    kind: parsed.kind ?? stored?.kind ?? null,
    watches: parsed.watches ?? stored?.watches ?? null,
    when: parsed.when ?? stored?.when ?? null,
    how: parsed.how ?? stored?.how ?? null,
    tells: parsed.tells ?? stored?.tells ?? null,
    asking: parsed.asking,
    live: stored?.live ?? false,
  };
}
