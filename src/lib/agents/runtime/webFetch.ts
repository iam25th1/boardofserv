import "server-only";
import { promises as dns } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import zlib from "node:zlib";

// web.fetch for real jobs: one GET of a public web page, its text back.
//
// - http and https only, GET only, no credentials in the address, no
//   cookies or other headers of ours beyond the basics.
// - Never a private, loopback, link-local, carrier-grade, multicast,
//   reserved or cloud metadata address: every address a name resolves to is
//   checked, the connection is made to a checked address only (so a name
//   that resolves differently a moment later can't slip through), and every
//   redirect is checked again the same way, up to five.
// - A time limit on the whole fetch, a size limit on the body (counted
//   after decompression, so a small compressed bomb stays small), text
//   types only.
// - HTML comes back as its readable text: no scripts, styles or tags,
//   table cells split by " | ", one line per block.
//
// The text is the page's, not the maker's or the owner's: the run marks
// everything made from it as untrusted, and SERV is told to treat it as
// data and never as instructions (runner.ts).

export const WEB_FETCH_TIMEOUT_MS = 10_000;
export const WEB_FETCH_MAX_BYTES = 1_000_000;
export const WEB_FETCH_MAX_TEXT = 50_000;
export const WEB_FETCH_MAX_REDIRECTS = 5;

export interface WebPolicy {
  // Exact origins ("http://127.0.0.1:4321") let through whatever their
  // address. Only tests and the development demo set this, for a page they
  // serve themselves; the server's runtime never does.
  allowOrigins?: string[];
  // In place of DNS (tests).
  lookup?: (host: string) => Promise<{ address: string; family: number }[]>;
  timeoutMs?: number;
  maxBytes?: number;
}

// The agent asked for something it may not have: its own logic.
export class WebRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebRefused";
  }
}

// The network let it down: worth another try later.
export class WebUnreachable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebUnreachable";
  }
}

// Address ranges no agent may reach.
const V4_BLOCKED: [string, number][] = [
  ["0.0.0.0", 8], // this network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT (and some clouds' metadata)
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata (169.254.169.254)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
];

const v4ToInt = (ip: string) => ip.split(".").reduce((n, part) => n * 256 + Number(part), 0);

function v4Blocked(ip: string): boolean {
  const n = v4ToInt(ip);
  return V4_BLOCKED.some(([base, bits]) => {
    const size = 2 ** (32 - bits);
    const start = v4ToInt(base);
    return n >= start && n < start + size;
  });
}

// An IPv6 address as eight 16-bit groups.
function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().split("%")[0]!;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const n = v4ToInt(dotted[1]!);
    s = `${s.slice(0, -dotted[1]!.length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = s.split("::") as [string, string | undefined];
  const a = head ? head.split(":") : [];
  const b = tail !== undefined ? (tail ? tail.split(":") : []) : [];
  const fill = tail !== undefined ? 8 - a.length - b.length : 0;
  const groups = [...a, ...Array(Math.max(0, fill)).fill("0"), ...b].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

function v6Blocked(ip: string): boolean {
  const g = v6Groups(ip);
  if (!g) return true;
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (zero(0, 8)) return true; // unspecified
  if (zero(0, 7) && g[7] === 1) return true; // loopback
  if (zero(0, 5) && g[5] === 0xffff) return v4Blocked(v4(g[6]!, g[7]!)); // IPv4-mapped
  if (zero(0, 6)) return v4Blocked(v4(g[6]!, g[7]!)); // IPv4-compatible
  if (g[0] === 0x64 && g[1] === 0xff9b) return zero(2, 6) ? v4Blocked(v4(g[6]!, g[7]!)) : true; // NAT64
  if (g[0] === 0x2002) return v4Blocked(v4(g[1]!, g[2]!)); // 6to4
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true; // documentation
  if (g[0] === 0x100 && zero(1, 4)) return true; // discard
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // unique local, AWS metadata (fd00:ec2::254)
  if ((g[0]! & 0xffc0) === 0xfe80 || (g[0]! & 0xffc0) === 0xfec0) return true; // link-local, site-local
  if ((g[0]! & 0xff00) === 0xff00) return true; // multicast
  return false;
}

// True for any address an agent may not reach.
export function blockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return v4Blocked(ip);
  if (family === 6) return v6Blocked(ip);
  return true;
}

const BLOCKED_NAMES = /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$|^metadata(\.google\.internal)?$/i;

function checkUrl(raw: string, policy: WebPolicy): { url: URL; allowed: boolean } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebRefused("That isn't a web address.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new WebRefused(`Only http and https pages can be fetched, not ${url.protocol.replace(":", "")}.`);
  if (url.username || url.password) throw new WebRefused("Addresses with a name or password in them can't be fetched.");
  const allowed = policy.allowOrigins?.includes(url.origin) ?? false;
  if (allowed) return { url, allowed };
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (blockedAddress(host)) throw new WebRefused("That address is private, local or reserved, so it can't be fetched.");
  } else if (BLOCKED_NAMES.test(host)) {
    throw new WebRefused("That address is private, local or reserved, so it can't be fetched.");
  }
  return { url, allowed };
}

// DNS that only ever hands the connection checked addresses.
function checkedLookup(policy: WebPolicy): LookupFunction {
  return ((hostname: string, options: { all?: boolean }, callback: (err: Error | null, address: unknown, family?: number) => void) => {
    const resolve = policy.lookup ?? (async (h: string) => (await dns.lookup(h, { all: true, verbatim: true })) as { address: string; family: number }[]);
    resolve(hostname).then(
      (found) => {
        if (!found.length) return callback(new WebUnreachable("That address doesn't resolve."), null);
        if (found.some((a) => blockedAddress(a.address))) return callback(new WebRefused("That address points to a private, local or reserved network, so it can't be fetched."), null);
        if (options?.all) return callback(null, found);
        callback(null, found[0]!.address, found[0]!.family);
      },
      () => callback(new WebUnreachable("That address doesn't resolve."), null),
    );
  }) as unknown as LookupFunction;
}

const TEXT_TYPES = /^(text\/|application\/(json|xml|xhtml\+xml|rss\+xml|atom\+xml|ld\+json)|application\/[\w.+-]+\+(json|xml))/i;

interface Fetched {
  status: number;
  type: string;
  body: Buffer;
  url: string;
  cut: boolean;
}

function once(url: URL, allowed: boolean, policy: WebPolicy, deadline: number): Promise<Fetched | { redirect: string; status: number }> {
  const max = policy.maxBytes ?? WEB_FETCH_MAX_BYTES;
  const slow = new WebUnreachable(`The page took too long (over ${Math.round((policy.timeoutMs ?? WEB_FETCH_TIMEOUT_MS) / 1000)} seconds).`);
  return new Promise<Fetched | { redirect: string; status: number }>((resolve, reject) => {
    const left = deadline - Date.now();
    if (left <= 0) return reject(slow);
    const get = url.protocol === "https:" ? https.get : http.get;
    const timer = setTimeout(() => req.destroy(slow), left);
    const done = <T,>(fn: (v: T) => void) => (v: T) => {
      clearTimeout(timer);
      fn(v);
    };
    resolve = done(resolve);
    reject = done(reject);
    const req = get(
      url,
      {
        // An origin a test lets through resolves as it likes; every other
        // name only ever to checked addresses.
        ...(allowed ? {} : { lookup: checkedLookup(policy) }),
        headers: {
          "user-agent": "boardofserv-agent/1",
          accept: "text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.1",
          "accept-encoding": "gzip, deflate, br",
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location) {
          res.resume();
          return resolve({ redirect: new URL(location, url).toString(), status });
        }
        const type = String(res.headers["content-type"] ?? "text/plain");
        if (!TEXT_TYPES.test(type)) {
          res.destroy();
          return reject(new WebRefused(`That isn't a text page (${type.split(";")[0]}).`));
        }
        const encoding = String(res.headers["content-encoding"] ?? "").toLowerCase();
        const stream =
          encoding === "gzip" ? res.pipe(zlib.createGunzip()) : encoding === "deflate" ? res.pipe(zlib.createInflate()) : encoding === "br" ? res.pipe(zlib.createBrotliDecompress()) : res;
        const chunks: Buffer[] = [];
        let size = 0;
        let cut = false;
        stream.on("data", (c: Buffer) => {
          if (cut) return;
          size += c.length;
          if (size > max) {
            chunks.push(c.subarray(0, c.length - (size - max)));
            cut = true;
            res.destroy();
            resolve({ status, type, body: Buffer.concat(chunks), url: url.toString(), cut });
            return;
          }
          chunks.push(c);
        });
        stream.on("end", () => !cut && resolve({ status, type, body: Buffer.concat(chunks), url: url.toString(), cut }));
        stream.on("error", (err) => !cut && reject(err instanceof WebRefused ? err : new WebUnreachable("The page broke off.")));
      },
    );
    req.on("error", (err) => reject(err instanceof WebRefused || err instanceof WebUnreachable ? err : new WebUnreachable("The page couldn't be reached.")));
  });
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "(c)", reg: "(R)", hellip: "...", ndash: "-", mdash: "-", lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', bull: "*", middot: "*", euro: "EUR", pound: "GBP" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[e.toLowerCase()] ?? whole;
  });
}

// A page's readable text.
export function pageText(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const s = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|head|iframe|object)\b[\s\S]*?<\/\1\s*>/gi, " ")
    // Line breaks in the source mean nothing in HTML: only the tags do.
    .replace(/\s+/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(td|th)\s*>/gi, " | ")
    .replace(/<\/(tr|li|dt|dd)\s*>/gi, "\n")
    .replace(/<(tr|li|dt|dd|td|th)\b[^>]*>/gi, "")
    .replace(/<\/?(p|div|h[1-6]|section|article|header|footer|main|nav|aside|table|thead|tbody|ul|ol|pre|blockquote|dl|form|figure|figcaption)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, "");
  const lines = decodeEntities(s)
    .split("\n")
    .map((l) => l.replace(/[ \t\f\v ]+/g, " ").trim().replace(/\s*\|$/, "").trim());
  const kept: string[] = [];
  for (const l of lines) if (l || kept.at(-1)) kept.push(l);
  const text = kept.join("\n").trim();
  return title ? `${decodeEntities(title).trim()}\n\n${text}` : text;
}

function decode(body: Buffer, type: string): string {
  const charset = /charset=([\w-]+)/i.exec(type)?.[1];
  try {
    return new TextDecoder(charset ?? "utf-8").decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

// One page: its status and text, or a WebRefused or WebUnreachable.
export async function fetchPage(raw: string, policy: WebPolicy = {}): Promise<{ status: number; text: string }> {
  const deadline = Date.now() + (policy.timeoutMs ?? WEB_FETCH_TIMEOUT_MS);
  let next = raw;
  for (let hops = 0; hops <= WEB_FETCH_MAX_REDIRECTS; hops++) {
    const { url, allowed } = checkUrl(next, policy);
    const got = await once(url, allowed, policy, deadline);
    if ("redirect" in got) {
      next = got.redirect;
      continue;
    }
    const raw = decode(got.body, got.type);
    let text = /html|xml/i.test(got.type) && /<[a-z!]/i.test(raw) ? pageText(raw) : raw.trim();
    const cut = got.cut || text.length > WEB_FETCH_MAX_TEXT;
    if (text.length > WEB_FETCH_MAX_TEXT) text = text.slice(0, WEB_FETCH_MAX_TEXT);
    return { status: got.status, text: cut ? `${text}\n[The page was longer: only its start is here.]` : text };
  }
  throw new WebRefused(`It was sent on more than ${WEB_FETCH_MAX_REDIRECTS} times.`);
}
