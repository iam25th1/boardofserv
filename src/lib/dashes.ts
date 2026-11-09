// No em dashes in what people read: every model answer shown to someone (a
// chat reply, a helper's answer) has them replaced as it streams, in the way
// that reads naturally:
//
//   "fast <em> and cheap"   becomes "fast, and cheap"
//   "pages 3<em>5"          becomes "pages 3-5"
//   "<em> a list item"      at the start of a line becomes "- a list item"
//   "done <em>" at the end of a line, or before punctuation, is dropped
//
// (<em> stands for the em dash, which this file never spells out.)
//
// Code is left exactly as it is: fenced blocks (``` or ~~~) and inline code
// spans. An inline span ends at its closing backticks or at the end of the
// line. Indented code blocks are not told apart from indented text.
//
// DashFix works on a stream: push() returns what can be shown now and holds
// back only what the next characters decide (spaces before a possible dash,
// a dash waiting for what follows it, a run of backticks). finish() flushes.

const EM = String.fromCharCode(0x2014);
const CLOSING = new Set([".", ",", ";", ":", "!", "?", ")", "]", "}", '"', "'", String.fromCharCode(0x201d), String.fromCharCode(0x2019)]);
const OPENING = new Set(["(", "[", "{", '"', "'", String.fromCharCode(0x201c), String.fromCharCode(0x2018)]);
const STOPS = new Set([",", ";", ":", ".", "!", "?"]);

const isDigit = (c: string) => c >= "0" && c <= "9";
const isBlank = (c: string) => c === " " || c === "\t";

export class DashFix {
  private pending = "";
  // Spaces after the last character shown, held until the next one decides
  // whether they stay (they go when a dash follows).
  private spaces = "";
  private last = "\n";
  private lineStart = true;
  private fence: { char: string; len: number } | null = null;
  // The length of the backtick run that opened an inline code span, or 0.
  private inline = 0;

  push(text: string): string {
    this.pending += text;
    return this.drain(false);
  }

  finish(): string {
    return this.drain(true) + this.flushSpaces();
  }

  private flushSpaces(): string {
    const s = this.spaces;
    this.spaces = "";
    return s;
  }

  private emit(text: string): string {
    if (!text) return "";
    this.last = text[text.length - 1]!;
    if (text.includes("\n")) this.lineStart = /\n[ \t]*$/.test(text);
    else if (!/^[ \t]*$/.test(text)) this.lineStart = false;
    return text;
  }

  private drain(final: boolean): string {
    const s = this.pending;
    let out = "";
    let i = 0;
    while (i < s.length) {
      const c = s[i]!;

      if (c === "\n") {
        out += this.emit(this.flushSpaces() + c);
        this.inline = 0;
        i++;
        continue;
      }

      // A fence opens or closes only at the start of a line.
      if (this.lineStart && this.inline === 0 && (c === "`" || c === "~")) {
        let j = i;
        while (j < s.length && s[j] === c) j++;
        if (j === s.length && !final) break;
        const len = j - i;
        if (len >= 3) {
          if (!this.fence) this.fence = { char: c, len };
          else if (this.fence.char === c && len >= this.fence.len) this.fence = null;
          out += this.emit(this.flushSpaces() + s.slice(i, j));
          i = j;
          continue;
        }
      }

      if (this.fence) {
        // Inside a fenced block everything is shown as it is.
        out += this.emit(this.flushSpaces() + c);
        i++;
        continue;
      }

      if (c === "`") {
        let j = i;
        while (j < s.length && s[j] === "`") j++;
        if (j === s.length && !final) break;
        const len = j - i;
        if (this.inline === 0) this.inline = len;
        else if (this.inline === len) this.inline = 0;
        out += this.emit(this.flushSpaces() + s.slice(i, j));
        i = j;
        continue;
      }

      if (this.inline > 0) {
        out += this.emit(this.flushSpaces() + c);
        i++;
        continue;
      }

      if (isBlank(c)) {
        if (this.lineStart) out += this.emit(c);
        else this.spaces += c;
        i++;
        continue;
      }

      if (c === EM) {
        // What follows decides, past any more dashes and spaces.
        let j = i + 1;
        while (j < s.length && (s[j] === EM || isBlank(s[j]!))) j++;
        if (j === s.length && !final) break;
        const next = j < s.length ? s[j]! : "";
        const spaced = this.spaces.length > 0 || j > i + 1;
        // A straight quote after a space opens a quotation, so it reads on.
        const closing = CLOSING.has(next) && !((next === '"' || next === "'") && isBlank(s[j - 1]!));
        if (next === "" || next === "\n" || closing) {
          // Nothing after it worth a comma: the dash and its spaces go.
          this.spaces = "";
        } else if (this.lineStart) {
          out += this.emit("- ");
        } else if (!spaced && isDigit(this.last) && isDigit(next)) {
          out += this.emit(this.flushSpaces() + "-");
        } else if (OPENING.has(this.last)) {
          this.spaces = "";
        } else if (STOPS.has(this.last)) {
          this.spaces = "";
          out += this.emit(" ");
        } else {
          this.spaces = "";
          out += this.emit(", ");
        }
        i = j;
        continue;
      }

      out += this.emit(this.flushSpaces() + c);
      i++;
    }
    this.pending = s.slice(i);
    return out;
  }
}

// The same, for a whole text at once.
export function fixDashes(text: string): string {
  if (!text.includes(EM)) return text;
  const fix = new DashFix();
  return fix.push(text) + fix.finish();
}
