import { describe, expect, it } from "vitest";
import { mergeSketch, parseSketchBlock, SketchSplitter, withSketch, type ParsedSketch } from "./sketchBlock";
import type { SketchDTO } from "./types";

const BLOCK =
  '{"name":"ETH floor watch","kind":"watcher","watches":"ETH price","when":"below $2,000","how":null,"tells":null,"asking":"how","choices":["Every minute","Every hour"]}';
const REPLY = `Got it. How often should it check?\n\n<<<SKETCH\n${BLOCK}\nSKETCH>>>`;

// Feeds chunks through a splitter and returns what the client would see after
// each chunk, plus the end state.
function run(chunks: string[]) {
  const split = new SketchSplitter();
  const shown = chunks.map((c) => split.push(c));
  const end = split.finish();
  return { shown, text: shown.join("") + end.rest, raw: end.raw };
}

// Every way to cut a string into two chunks.
function twoChunks(s: string): string[][] {
  return Array.from({ length: s.length - 1 }, (_, i) => [s.slice(0, i + 1), s.slice(i + 1)]);
}

describe("SketchSplitter", () => {
  it("cuts the block out cleanly", () => {
    const { text, raw } = run([REPLY]);
    expect(text).toBe("Got it. How often should it check?\n\n");
    expect(parseSketchBlock(raw)?.name).toBe("ETH floor watch");
  });

  it("finds the marker split across chunks, at every possible split", () => {
    for (const chunks of twoChunks(REPLY)) {
      const { text, raw } = run(chunks);
      expect(text).toBe("Got it. How often should it check?\n\n");
      expect(parseSketchBlock(raw)?.asking).toBe("how");
    }
  });

  it("never lets part of the marker reach the client, even one character at a time", () => {
    const { shown, text } = run([...REPLY]);
    expect(shown.join("")).not.toContain("<");
    expect(text).not.toContain("SKETCH");
  });

  it("holds back a possible marker start, then releases it when it was not one", () => {
    const split = new SketchSplitter();
    expect(split.push("Prices <<")).toBe("Prices ");
    expect(split.push("< 3 are rare")).toBe("<<< 3 are rare");
    expect(split.push("<<<SK")).toBe("");
    expect(split.finish()).toEqual({ rest: "<<<SK", raw: null });
  });

  it("with no block, shows the whole reply and finds no sketch", () => {
    const { text, raw } = run(["Just a reply", " with no block."]);
    expect(text).toBe("Just a reply with no block.");
    expect(raw).toBeNull();
    expect(parseSketchBlock(raw)).toBeNull();
  });

  it("drops text after the closing marker", () => {
    const { text, raw } = run([`${REPLY}\n\nAnything else?`]);
    expect(text).toBe("Got it. How often should it check?\n\n");
    expect(parseSketchBlock(raw)?.name).toBe("ETH floor watch");
  });

  it("still reads a complete block whose closing marker never came", () => {
    const { raw } = run([`Hi\n<<<SKETCH\n${BLOCK}\n`]);
    expect(parseSketchBlock(raw)?.watches).toBe("ETH price");
  });
});

describe("parseSketchBlock", () => {
  it("rejects invalid JSON, a non-object and wrong types", () => {
    expect(parseSketchBlock('{"name": "ETH floor watch",')).toBeNull();
    expect(parseSketchBlock("[1, 2]")).toBeNull();
    expect(parseSketchBlock('{"name": 5}')).toBeNull();
  });

  it("reads missing fields, empty strings and the string null as unknown", () => {
    expect(parseSketchBlock('{"name":"Digest","when":"","how":"null"}')).toEqual({
      name: "Digest",
      kind: null,
      watches: null,
      when: null,
      how: null,
      tells: null,
      asking: null,
      choices: [],
    });
  });

  it("keeps kind and asking to their known values, and choices to four short ones", () => {
    const parsed = parseSketchBlock(
      '{"name":"x","kind":"Robot","asking":"Tells","choices":["A","a ","B","","C","D","E",7]}',
    );
    expect(parsed?.kind).toBeNull();
    expect(parsed?.asking).toBe("tells");
    expect(parsed?.choices).toEqual(["A", "a", "B", "C"]);
  });

  it("cuts a field that runs long", () => {
    expect(parseSketchBlock(`{"watches":"${"w".repeat(200)}"}`)?.watches).toHaveLength(80);
  });
});

describe("mergeSketch", () => {
  const stored: SketchDTO = {
    name: "ETH floor watch",
    kind: "watcher",
    watches: "ETH price",
    when: "below $2,000",
    how: "every 5 minutes",
    tells: null,
    asking: "tells",
    live: false,
  };
  const reply = (p: Partial<ParsedSketch>): ParsedSketch => ({
    name: null,
    kind: null,
    watches: null,
    when: null,
    how: null,
    tells: null,
    asking: null,
    choices: [],
    ...p,
  });

  it("takes every value from the first sketch", () => {
    expect(mergeSketch(null, reply({ name: "A", watches: "B", asking: "when" }))).toEqual({
      name: "A",
      kind: null,
      watches: "B",
      when: null,
      how: null,
      tells: null,
      asking: "when",
      live: false,
    });
  });

  it("never lets a null wipe a stored value", () => {
    expect(mergeSketch(stored, reply({ tells: "Telegram" }))).toEqual({ ...stored, tells: "Telegram", asking: null });
  });

  it("lets a new value replace the stored one (a change of mind)", () => {
    expect(mergeSketch(stored, reply({ when: "below $1,800" })).when).toBe("below $1,800");
  });

  it("always takes asking from the latest reply, and keeps live as stored", () => {
    expect(mergeSketch({ ...stored, live: true }, reply({ asking: "how" }))).toMatchObject({ asking: "how", live: true });
  });
});

describe("withSketch", () => {
  it("puts the stored sketch back on the latest reply only", () => {
    const sketch: SketchDTO = { name: "N", kind: null, watches: "W", when: null, how: null, tells: null, asking: "when", live: false };
    const out = withSketch(
      [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
        { role: "user", content: "c" },
        { role: "assistant", content: "d" },
        { role: "user", content: "e" },
      ],
      sketch,
    );
    expect(out[1]?.content).toBe("b");
    const split = new SketchSplitter();
    expect(split.push(out[3]!.content)).toBe("d\n\n");
    expect(parseSketchBlock(split.finish().raw)).toMatchObject({ name: "N", watches: "W", asking: "when", choices: [] });
    expect(withSketch([{ role: "user", content: "a" }], sketch)).toEqual([{ role: "user", content: "a" }]);
  });
});

