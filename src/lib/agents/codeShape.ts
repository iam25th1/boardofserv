// The shape of a step's code, as far as its loops go: where each loop's
// body starts and ends, and how many loops a call sits inside. Read off
// the text, never run. Enough to tell a step that asks SERV once per item
// from one that asks once per file of every item, and one that saves its
// place after each item from one that saves it at the end.

type Span = [number, number];

// The code with its strings and comments blanked out (same length), so
// brackets in them don't count.
function blanked(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    const two = source.slice(i, i + 2);
    if (two === "//") {
      const end = source.indexOf("\n", i);
      const stop = end < 0 ? source.length : end;
      out += " ".repeat(stop - i);
      i = stop;
    } else if (two === "/*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end < 0 ? source.length : end + 2;
      out += source.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < source.length && source[j] !== ch) j += source[j] === "\\" ? 2 : 1;
      out += ch + " ".repeat(Math.max(0, Math.min(j, source.length) - i - 1)) + (j < source.length ? ch : "");
      i = j + 1;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

// Where the bracket opening at i closes.
function closing(code: string, i: number): number {
  const open = code[i]!;
  const close = open === "(" ? ")" : open === "{" ? "}" : "]";
  let depth = 0;
  for (let j = i; j < code.length; j++) {
    if (code[j] === open) depth++;
    else if (code[j] === close && --depth === 0) return j;
  }
  return code.length;
}

// Each loop's body: for and while loops (their block, or their one
// statement), and the callbacks of forEach, map and their kin.
export function loopSpans(source: string): Span[] {
  return codeLoops(source).map((l) => l.span);
}

// Each loop with what it goes through: a for loop's head, or what a
// forEach or map is called on.
export function codeLoops(source: string): { span: Span; over: string }[] {
  const code = blanked(source);
  const loops: { span: Span; over: string }[] = [];
  for (const m of code.matchAll(/\b(?:for|while)\s*(?:await\s*)?\(/g)) {
    const head = m.index! + m[0].length - 1;
    const after = closing(code, head) + 1;
    const over = source.slice(head + 1, after - 1);
    const rest = code.slice(after);
    const lead = rest.length - rest.trimStart().length;
    const at = after + lead;
    if (code[at] === "{") loops.push({ span: [at, closing(code, at)], over });
    else {
      const end = code.indexOf(";", at);
      loops.push({ span: [at, end < 0 ? code.length : end], over });
    }
  }
  for (const m of code.matchAll(/\.\s*(?:forEach|map|flatMap|filter|reduce|some|every|find)\s*\(/g)) {
    const open = m.index! + m[0].length - 1;
    const over = /[\w$.\]\[)]+$/.exec(source.slice(Math.max(0, m.index! - 60), m.index!))?.[0] ?? "";
    loops.push({ span: [open, closing(code, open)], over });
  }
  return loops;
}

// Where the code calls a tool (tools.serv.reason, tools.memory.set).
export function callsOf(source: string, tool: string): number[] {
  const code = blanked(source);
  const [group, name] = tool.split(".");
  return [...code.matchAll(new RegExp(`\\btools\\s*\\.\\s*${group}\\s*\\.\\s*${name}\\s*\\(`, "g"))].map((m) => m.index!);
}

// The loops a place in the code sits inside, innermost last.
export function loopsAround(spans: Span[], at: number): Span[] {
  return spans.filter(([a, b]) => a < at && at < b).sort((x, y) => y[1] - y[0] - (x[1] - x[0]));
}
