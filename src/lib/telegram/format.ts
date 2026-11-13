// Text for Telegram. Agents write messages the way people write chat:
// *bold*, **bold**, _italic_, `code`, "# A heading", "- a point",
// [a link](https://...). Sent as they are, Telegram shows the marks
// themselves, asterisks and all. So a message goes as Telegram's HTML, with
// everything in it escaped first and those marks made into the few tags
// Telegram reads; or, when that is refused, as plain text with the marks
// taken out. Never raw markdown.

const escape = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Emphasis that opens after a space or the start, closes before a space,
// punctuation or the end, and holds no line break: "2 * 3 * 4" and
// snake_case_names are left alone.
const STRONG = /\*\*(?=\S)([^\n]+?)(?<=\S)\*\*|__(?=\S)([^\n]+?)(?<=\S)__/g;
const STAR = /(^|[\s(["'])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?=$|[\s).,!?:;"'\]])/gm;
const UNDER = /(^|[\s(["'])_(?=[^\s_])([^_\n]*?[^\s_])_(?=$|[\s).,!?:;"'\]])/gm;
const CODE = /`([^`\n]+)`/g;
const LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
const HEADING = /^#{1,6}\s+(.+?)\s*#*\s*$/gm;
const BULLET = /^(\s*)[-*+]\s+(?=\S)/gm;

// The same text with every mark taken out.
export function plainText(text: string): string {
  return text
    .replace(HEADING, "$1")
    .replace(BULLET, "$1• ")
    .replace(LINK, "$1 ($2)")
    .replace(CODE, "$1")
    .replace(STRONG, (_m, a?: string, b?: string) => a ?? b ?? "")
    .replace(STAR, "$1$2")
    .replace(UNDER, "$1$2")
    .replace(/\*{2,}|_{2,}/g, "");
}

// Telegram's HTML for it: the text escaped, and its marks as <b>, <i>,
// <code> and <a> tags, never overlapping.
export function telegramHtml(text: string): string {
  // Code first, kept aside so nothing inside it becomes a tag.
  const codes: string[] = [];
  const links: string[] = [];
  let t = text.replace(CODE, (_m, c: string) => `\u0000c${codes.push(`<code>${escape(c)}</code>`) - 1}\u0000`);
  t = t.replace(LINK, (_m, label: string, url: string) => `\u0000l${links.push(`<a href="${escape(url).replace(/"/g, "&quot;")}">${escape(label)}</a>`) - 1}\u0000`);
  t = escape(t)
    .replace(HEADING, "<b>$1</b>")
    .replace(BULLET, "$1• ")
    .replace(STRONG, (_m, a?: string, b?: string) => `<b>${a ?? b ?? ""}</b>`)
    .replace(STAR, "$1<b>$2</b>")
    .replace(UNDER, "$1<i>$2</i>")
    .replace(/\*{2,}|_{2,}/g, "");
  return t.replace(/\u0000([cl])(\d+)\u0000/g, (_m, kind: string, i: string) => (kind === "c" ? codes : links)[Number(i)] ?? "");
}
