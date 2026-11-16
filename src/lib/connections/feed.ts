// A feed's newest items (RSS or Atom), each its title, link, date and
// summary as plain text, for an agent reading one through the catalog's
// RSS entry. Anything that isn't a feed comes back as it was.

const MAX_ITEMS = 50;

const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, e: string) => {
      const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
      if (e[0] !== "#") return named[e.toLowerCase()] ?? whole;
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
    });

const plain = (s: string) =>
  decode(s)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function tag(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(xml);
  return m ? m[1]! : null;
}

export interface FeedItem {
  title: string;
  link: string;
  published: string | null;
  summary: string;
}

export function parseFeed(text: string): { items: FeedItem[] } | null {
  if (!/<(rss|feed|rdf:RDF)\b/i.test(text)) return null;
  const blocks = [...text.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => m[2]!).slice(0, MAX_ITEMS);
  return {
    items: blocks.map((b) => {
      const href = /<link\b[^>]*href="([^"]+)"/i.exec(b)?.[1];
      const summary = plain(tag(b, "description") ?? tag(b, "summary") ?? tag(b, "content") ?? "");
      return {
        title: plain(tag(b, "title") ?? ""),
        link: decode(href ?? tag(b, "link") ?? "").trim(),
        published: plain(tag(b, "pubDate") ?? tag(b, "published") ?? tag(b, "updated") ?? tag(b, "dc:date") ?? "") || null,
        summary: summary.length > 1000 ? `${summary.slice(0, 1000)}...` : summary,
      };
    }),
  };
}
