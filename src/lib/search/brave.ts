import "server-only";
import type { Services } from "../agents/runtime/context";

// Web search for agents, through Brave's Search API
// (api-dashboard.search.brave.com): GET /res/v1/web/search with the key in
// X-Subscription-Token, results under web.results with a title, url and
// description each. Brave allows 50 requests a second on this account and
// answers 429 past its limit; only successful searches are billed.
//
// What comes back is text from the open web: the runtime marks whatever an
// agent makes from it as untrusted, and SERV is told never to follow it.

const ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
export const RESULTS = 5;

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

// Brave couldn't search just now (busy, unreachable): worth another try.
export class SearchUnavailable extends Error {
  constructor(message = "Web search couldn't be reached just now.") {
    super(message);
    this.name = "SearchUnavailable";
  }
}

// Brave refused (the key, the query): not worth trying again.
export class SearchRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchRefused";
  }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };
// Plain text: tags out, the common entities read, spaces collapsed.
const plain = (v: unknown, max: number) =>
  typeof v === "string"
    ? v
        .replace(/<[^>]*>/g, "")
        .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, e: string) => ENTITIES[e] ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max)
    : "";

export async function braveSearch(services: Services, query: string): Promise<SearchResult[]> {
  if (!services.braveKey) throw new SearchRefused("Web search isn't set up here.");
  const q = new URLSearchParams({ q: query, count: String(RESULTS), safesearch: "moderate", text_decorations: "false" });
  let res: Response;
  try {
    res = await services.fetch(`${ENDPOINT}?${q}`, {
      headers: { accept: "application/json", "x-subscription-token": services.braveKey },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new SearchUnavailable();
  }
  if (res.status === 429) throw new SearchUnavailable("Web search is busy just now; it tries again shortly.");
  if (res.status === 401 || res.status === 403) throw new SearchRefused("Web search refused boardofserv's key.");
  if (res.status === 422 || res.status === 400) throw new SearchRefused("Web search couldn't take that query.");
  if (!res.ok) throw new SearchUnavailable();
  const body = (await res.json().catch(() => null)) as { web?: { results?: { title?: unknown; url?: unknown; description?: unknown }[] } } | null;
  return (body?.web?.results ?? [])
    .filter((r) => typeof r.url === "string" && /^https?:\/\//.test(r.url))
    .slice(0, RESULTS)
    .map((r) => ({ title: plain(r.title, 300), url: String(r.url).slice(0, 2000), snippet: plain(r.description, 600) }));
}
