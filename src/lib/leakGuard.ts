import "server-only";

// Keeps a published helper's instructions out of its answers. An answer is
// stopped when it carries the helper's canary, or a run of LEAK_RUN_WORDS or
// more consecutive words from its system prompt (compared as lower case
// letters and digits, so case and punctuation do not hide a run).
//
// The answer streams through push(), which returns only text that can no
// longer become part of a leak. Held back each time: the last word while it
// may still be growing, and the longest tail of whole words that is itself a
// run of the prompt, since the next words could complete a leak. So a leak is
// caught, even split across chunks, before any word of it is shown. Ordinary
// text is held a word or two at most.

export const LEAK_RUN_WORDS = 12;
export const BLOCKED_MESSAGE = "This helper can't share how it works.";

const normal = (raw: string) => raw.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

interface Word {
  start: number;
  norm: string;
}

// The words of `text` that have something to compare, with where each starts.
function wordsOf(text: string): Word[] {
  const out: Word[] = [];
  for (const m of text.matchAll(/\S+/g)) {
    const norm = normal(m[0]);
    if (norm) out.push({ start: m.index, norm });
  }
  return out;
}

export interface GuardStep {
  // Text that is safe to show now.
  text: string;
  blocked: boolean;
}

export class LeakGuard {
  private text = "";
  private sent = 0;
  private stopped = false;
  // Every run of 1 to LEAK_RUN_WORDS consecutive prompt words, joined by
  // single spaces. A run of the full length is a leak; a shorter one at the
  // end of the answer may become one.
  private readonly runs = new Set<string>();
  private readonly canary: string;

  constructor(systemPrompt: string, canary: string) {
    const words = wordsOf(systemPrompt).map((w) => w.norm);
    for (let i = 0; i < words.length; i++) {
      for (let k = 1; k <= LEAK_RUN_WORDS && i + k <= words.length; k++) this.runs.add(words.slice(i, i + k).join(" "));
    }
    this.canary = normal(canary);
  }

  get blocked(): boolean {
    return this.stopped;
  }

  push(chunk: string): GuardStep {
    if (this.stopped) return { text: "", blocked: true };
    this.text += chunk;
    return this.step(false);
  }

  // At the end of the answer: the last word is whole now, so it is checked
  // and, if nothing leaks, everything held is shown.
  finish(): GuardStep {
    if (this.stopped) return { text: "", blocked: true };
    return this.step(true);
  }

  private step(final: boolean): GuardStep {
    let words = wordsOf(this.text);
    // A last word with nothing after it may still grow.
    const growing = !final && words.length > 0 && !/\s$/.test(this.text);
    const open = growing ? words.at(-1)! : null;
    if (growing) words = words.slice(0, -1);

    if (this.canary && normal(this.text).includes(this.canary)) return this.stop();
    for (let end = LEAK_RUN_WORDS; end <= words.length; end++) {
      if (this.runs.has(join(words, end - LEAK_RUN_WORDS, end))) return this.stop();
    }
    if (final) return this.release(this.text.length);

    // Hold the longest tail of whole words that is a run of the prompt.
    let hold = words.length;
    for (let from = Math.max(0, words.length - (LEAK_RUN_WORDS - 1)); from < words.length; from++) {
      if (this.runs.has(join(words, from, words.length))) {
        hold = from;
        break;
      }
    }
    const cut = Math.min(hold < words.length ? words[hold]!.start : this.text.length, open ? open.start : this.text.length);
    return this.release(cut);
  }

  private release(upTo: number): GuardStep {
    const text = upTo > this.sent ? this.text.slice(this.sent, upTo) : "";
    this.sent = Math.max(this.sent, upTo);
    return { text, blocked: false };
  }

  private stop(): GuardStep {
    this.stopped = true;
    return { text: "", blocked: true };
  }
}

function join(words: Word[], from: number, to: number): string {
  return words
    .slice(from, to)
    .map((w) => w.norm)
    .join(" ");
}
