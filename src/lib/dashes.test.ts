import { describe, expect, it } from "vitest";
import { DashFix, fixDashes } from "./dashes";

// Em dashes never reach what people read, and code keeps its own. Built from
// a code point so this file holds none either.
const EM = String.fromCharCode(0x2014);

const CASES: [string, string, string][] = [
  ["between words, spaced", `fast ${EM} and cheap`, "fast, and cheap"],
  ["between words, tight", `fast${EM}and cheap`, "fast, and cheap"],
  ["a pair around an aside", `The mug ${EM} hand thrown ${EM} is heavy.`, "The mug, hand thrown, is heavy."],
  ["between numbers", `pages 3${EM}5`, "pages 3-5"],
  ["starting a line", `Two things:\n${EM} warm\n${EM} short`, "Two things:\n- warm\n- short"],
  ["ending a line", `done ${EM}\nnext`, "done\nnext"],
  ["before punctuation", `done ${EM}.`, "done."],
  ["after a comma", `a, ${EM} b`, "a, b"],
  ["before an opening quote", `He said ${EM} "hi"`, `He said, "hi"`],
  ["after an opening bracket", `(${EM}aside)`, "(aside)"],
  ["a run of them", `wait ${EM}${EM} what`, "wait, what"],
  ["alone", EM, ""],
  ["a fenced block", "```\nx = a " + EM + " b\n```\nafter " + EM + " this", "```\nx = a " + EM + " b\n```\nafter, this"],
  ["a tilde fence with a language", "~~~js\nconst s = '" + EM + "';\n~~~\nok " + EM + " fine", "~~~js\nconst s = '" + EM + "';\n~~~\nok, fine"],
  ["inline code", "use `a " + EM + " b` here " + EM + " ok", "use `a " + EM + " b` here, ok"],
  ["double backtick code", "``a ` " + EM + " b`` then " + EM + " on", "``a ` " + EM + " b`` then, on"],
  ["nothing to change", "no dashes  here\n  indented, - hyphens -- too", "no dashes  here\n  indented, - hyphens -- too"],
];

describe("fixDashes", () => {
  it.each(CASES)("%s", (_, text, want) => {
    expect(fixDashes(text)).toBe(want);
  });
});

describe("DashFix, streaming", () => {
  it("gives the same text however the stream is cut", () => {
    for (const [, text, want] of CASES) {
      for (let size = 1; size <= 5; size++) {
        const fix = new DashFix();
        let out = "";
        for (let i = 0; i < text.length; i += size) out += fix.push(text.slice(i, i + size));
        expect(out + fix.finish(), `${JSON.stringify(text)} in pieces of ${size}`).toBe(want);
      }
    }
  });

  it("holds back only what the next characters decide", () => {
    const fix = new DashFix();
    expect(fix.push("Meet the mug ")).toBe("Meet the mug");
    expect(fix.push(EM)).toBe("");
    expect(fix.push(" hand")).toBe(", hand");
    expect(fix.push(" thrown")).toBe(" thrown");
    expect(fix.finish()).toBe("");
  });
});
