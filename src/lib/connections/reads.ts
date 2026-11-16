import { z } from "zod";
import type { ServiceCall } from "./request";

// The typed read tools: one per service where an agent's reading is common
// enough to deserve its own shape. Each is one call to its service through
// the owner's connection (or none, for a public one), and its answer comes
// back flat, in the shape its signature says, so Dolphin writes against
// fields rather than a service's raw API. Everything else a service
// answers is reached with service.request.
//
// Plain data and pure functions: the toolbox (signatures), the runtime
// (calls) and the test bench (stand-ins) share it.

export interface TypedRead {
  tool: string;
  service: string;
  args: z.ZodTypeAny;
  summary: string;
  signature: string;
  // Where its data comes from, in a sentence ("a GitHub repository").
  outside: string;
  // What it does, after "couldn't" ("read GitHub").
  verb: string;
  request: (args: never) => ServiceCall;
  // The service's answer, in the tool's own shape.
  shape: (data: unknown, args: never) => unknown;
}

const LIMIT = z.number().int().min(1).max(50).optional();
const cut = (v: unknown, n: number) => (typeof v === "string" ? (v.length > n ? `${v.slice(0, n)}...` : v) : (v ?? null));
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const at = (v: unknown, path: string): unknown => path.split(".").reduce<unknown>((o, k) => obj(o)[k], v);
// A field name from a question's or column's title: project_name for "Project name".
export const fieldName = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60) || "field";

const REPO = z.string().regex(/^[\w.-]+\/[\w.-]+$/, "a repository is owner/name, like vercel/next.js");
const repoPath = (repo: string) => repo.split("/").map(encodeURIComponent).join("/");

const github: TypedRead = {
  tool: "github.read",
  service: "github",
  args: z.object({
    op: z.enum(["commits", "pulls", "issues", "pull", "commit"]),
    repo: REPO,
    number: z.number().int().min(1).optional(),
    sha: z.string().regex(/^[0-9a-f]{7,40}$/i).optional(),
    state: z.enum(["open", "closed", "all"]).optional(),
    since: z.string().max(40).optional(),
    limit: LIMIT,
  }),
  summary: "Read a GitHub repository (owner/name; public ones need no key): its commits, pull requests or issues, or one pull request's or commit's changed files with their patches.",
  signature:
    'tools.github.read({ op: "commits" | "pulls" | "issues" | "pull" | "commit", repo: string, number?: number, sha?: string, state?: "open" | "closed" | "all", since?: string, limit?: number }): Promise<{ items: Array<Record<string, string | number | boolean | null>> }> // commits: { sha, message, author, date, url }; pulls: { number, title, author, state, draft, created_at, merged_at, url, body }; issues: { number, title, author, state, labels, created_at, url, body }; pull (number) and commit (sha): its changed files { filename, status, additions, deletions, patch }',
  outside: "a GitHub repository",
  verb: "read GitHub",
  request: (a: { op: string; repo: string; number?: number; sha?: string; state?: string; since?: string; limit?: number }) => {
    const per_page = a.limit ?? 10;
    const base = `/repos/${repoPath(a.repo)}`;
    if (a.op === "pull") return { method: "GET", path: `${base}/pulls/${a.number ?? 0}/files`, query: { per_page: Math.min(per_page, 30) } };
    if (a.op === "commit") return { method: "GET", path: `${base}/commits/${encodeURIComponent(a.sha ?? "")}` };
    if (a.op === "commits") return { method: "GET", path: `${base}/commits`, query: { per_page, ...(a.since ? { since: a.since } : {}) } };
    return { method: "GET", path: `${base}/${a.op}`, query: { per_page, state: a.state ?? "open", ...(a.since && a.op === "issues" ? { since: a.since } : {}) } };
  },
  shape: (data: unknown, a: { op: string }) => {
    const files = (v: unknown) => list(v).map((f) => ({ filename: f.filename ?? null, status: f.status ?? null, additions: f.additions ?? 0, deletions: f.deletions ?? 0, patch: cut(f.patch, 3000) }));
    if (a.op === "pull") return { items: files(data) };
    if (a.op === "commit") return { items: files(obj(data).files) };
    if (a.op === "commits") return { items: list(data).map((c) => ({ sha: c.sha ?? null, message: String(at(c, "commit.message") ?? "").split("\n")[0], author: (at(c, "commit.author.name") ?? at(c, "author.login") ?? null) as string | null, date: (at(c, "commit.author.date") ?? null) as string | null, url: c.html_url ?? null })) };
    const people = (x: Record<string, unknown>) => (at(x, "user.login") ?? null) as string | null;
    if (a.op === "pulls") return { items: list(data).map((p) => ({ number: p.number ?? null, title: p.title ?? null, author: people(p), state: p.state ?? null, draft: Boolean(p.draft), created_at: p.created_at ?? null, merged_at: p.merged_at ?? null, url: p.html_url ?? null, body: cut(p.body, 1000) })) };
    return { items: list(data).filter((i) => !i.pull_request).map((i) => ({ number: i.number ?? null, title: i.title ?? null, author: people(i), state: i.state ?? null, labels: list(i.labels).map((l) => String(l.name ?? "")).join(", "), created_at: i.created_at ?? null, url: i.html_url ?? null, body: cut(i.body, 1000) })) };
  },
};

// A Tally form's id from its link (tally.so/r/abc123, tally.so/forms/abc123) or the id.
export const tallyFormId = (form: string) => /(?:tally\.so\/(?:r|forms)\/)?([A-Za-z0-9]{4,20})\/?(?:[?#].*)?$/.exec(form.trim())?.[1] ?? form.trim();

const tally: TypedRead = {
  tool: "tally.read",
  service: "tally",
  args: z.object({ form: z.string().min(4).max(300), limit: LIMIT }),
  summary: "Read the answers to the owner's Tally form (by its link): each a record of its id, when it came in, and every answer under its question's title in lower case with underscores.",
  signature: "tools.tally.read({ form: string, limit?: number }): Promise<{ responses: Array<{ id: string, submittedAt: string, [field: string]: string | number | boolean | string[] | null }> }> // each answer under its question's title in lower case with underscores",
  outside: "a form's responses",
  verb: "read your Tally form's answers",
  request: (a: { form: string; limit?: number }) => ({ method: "GET", path: `/forms/${encodeURIComponent(tallyFormId(a.form))}/submissions`, query: { filter: "completed", limit: a.limit ?? 50 } }),
  shape: (data: unknown) => {
    const titles = new Map(list(obj(data).questions).map((q) => [String(q.id), fieldName(String(q.title ?? q.id))]));
    return {
      responses: list(obj(data).submissions).map((s) => ({
        id: String(s.id ?? ""),
        submittedAt: String(s.submittedAt ?? ""),
        ...Object.fromEntries(list(s.responses).map((r) => [titles.get(String(r.questionId)) ?? fieldName(String(r.questionId)), (r.value ?? null) as unknown])),
      })),
    };
  },
};

const airtable: TypedRead = {
  tool: "airtable.read",
  service: "airtable",
  args: z.object({ base: z.string().regex(/^app[A-Za-z0-9]{8,20}$/, "a base's id starts with app"), table: z.string().min(1).max(100), view: z.string().max(100).optional(), formula: z.string().max(500).optional(), limit: LIMIT }),
  summary: "Read records of a table in the owner's Airtable base: each its id, when it was made, and its fields by their names.",
  signature: "tools.airtable.read({ base: string, table: string, view?: string, formula?: string, limit?: number }): Promise<{ records: Array<{ id: string, createdTime: string, [field: string]: unknown }> }> // fields under their own names, as in the table",
  outside: "an Airtable table",
  verb: "read your Airtable table",
  request: (a: { base: string; table: string; view?: string; formula?: string; limit?: number }) => ({ method: "GET", path: `/${a.base}/${encodeURIComponent(a.table)}`, query: { pageSize: a.limit ?? 50, ...(a.view ? { view: a.view } : {}), ...(a.formula ? { filterByFormula: a.formula } : {}) } }),
  shape: (data: unknown) => ({ records: list(obj(data).records).map((r) => ({ id: String(r.id ?? ""), createdTime: String(r.createdTime ?? ""), ...obj(r.fields) })) }),
};

// A Notion database's id from its link or the id, with its dashes.
export const notionId = (v: string) => {
  const hex = /([0-9a-f]{32})(?:[?#].*)?$/i.exec(v.replace(/-/g, ""))?.[1];
  return hex ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`.toLowerCase() : v.trim();
};

function notionValue(p: Record<string, unknown>): unknown {
  const text = (v: unknown) => list(v).map((t) => String(t.plain_text ?? "")).join("");
  switch (p.type) {
    case "title":
    case "rich_text":
      return text(p[p.type as string]);
    case "number":
    case "checkbox":
    case "url":
    case "email":
    case "phone_number":
    case "created_time":
    case "last_edited_time":
      return (p[p.type as string] ?? null) as unknown;
    case "select":
    case "status":
      return (at(p, `${p.type}.name`) ?? null) as unknown;
    case "multi_select":
      return list(p.multi_select).map((x) => String(x.name ?? ""));
    case "date":
      return (at(p, "date.start") ?? null) as unknown;
    case "people":
      return list(p.people).map((x) => String(x.name ?? ""));
    case "formula":
      return (obj(p.formula)[String(obj(p.formula).type)] ?? null) as unknown;
    default:
      return null;
  }
}

const notion: TypedRead = {
  tool: "notion.read",
  service: "notion",
  args: z.object({ database: z.string().min(32).max(300), limit: LIMIT }),
  summary: "Read the pages of a Notion database the owner shared with their integration (by its link): each its id, link, when it last changed, and every property by its name in lower case with underscores.",
  signature: "tools.notion.read({ database: string, limit?: number }): Promise<{ pages: Array<{ id: string, url: string, last_edited: string, [property: string]: unknown }> }> // each property under its name in lower case with underscores: text, number, true or false, a date, or a list of names",
  outside: "a Notion database",
  verb: "read your Notion database",
  request: (a: { database: string; limit?: number }) => ({ method: "POST", path: `/databases/${notionId(a.database)}/query`, body: { page_size: a.limit ?? 50 } }),
  shape: (data: unknown) => ({
    pages: list(obj(data).results).map((p) => ({
      id: String(p.id ?? ""),
      url: String(p.url ?? ""),
      last_edited: String(p.last_edited_time ?? ""),
      ...Object.fromEntries(Object.entries(obj(p.properties)).map(([name, v]) => [fieldName(name), notionValue(obj(v))])),
    })),
  }),
};

const linear: TypedRead = {
  tool: "linear.read",
  service: "linear",
  args: z.object({ team: z.string().max(20).optional(), state: z.string().max(60).optional(), limit: LIMIT }),
  summary: "Read issues from the owner's Linear workspace, by team key and state name.",
  signature: "tools.linear.read({ team?: string, state?: string, limit?: number }): Promise<{ issues: Array<{ id: string, title: string, state: string, assignee: string | null, priority: number, created_at: string, updated_at: string, url: string }> }>",
  outside: "a Linear workspace",
  verb: "read your Linear issues",
  request: (a: { team?: string; state?: string; limit?: number }) => ({
    method: "POST",
    path: "/graphql",
    body: {
      query: "query Issues($first: Int!, $filter: IssueFilter) { issues(first: $first, filter: $filter, orderBy: updatedAt) { nodes { identifier title priority createdAt updatedAt url state { name } assignee { name } } } }",
      variables: { first: a.limit ?? 25, filter: { ...(a.team ? { team: { key: { eq: a.team } } } : {}), ...(a.state ? { state: { name: { eqIgnoreCase: a.state } } } : {}) } },
    },
  }),
  shape: (data: unknown) => ({
    issues: list(at(data, "data.issues.nodes")).map((i) => ({ id: String(i.identifier ?? ""), title: String(i.title ?? ""), state: String(at(i, "state.name") ?? ""), assignee: (at(i, "assignee.name") ?? null) as string | null, priority: Number(i.priority ?? 0), created_at: String(i.createdAt ?? ""), updated_at: String(i.updatedAt ?? ""), url: String(i.url ?? "") })),
  }),
};

const shopify: TypedRead = {
  tool: "shopify.read",
  service: "shopify",
  args: z.object({ op: z.enum(["orders", "products", "customers"]), status: z.string().max(20).optional(), since: z.string().max(40).optional(), limit: LIMIT }),
  summary: "Read the owner's Shopify store: its orders, products or customers.",
  signature:
    'tools.shopify.read({ op: "orders" | "products" | "customers", status?: string, since?: string, limit?: number }): Promise<{ items: Array<Record<string, string | number | null>> }> // orders: { id, name, created_at, total, currency, paid, fulfilled, customer, items }; products: { id, title, status, vendor, price, inventory }; customers: { id, name, orders, spent }',
  outside: "a Shopify store",
  verb: "read your Shopify store",
  request: (a: { op: string; status?: string; since?: string; limit?: number }) => ({ method: "GET", path: `/${a.op}.json`, query: { limit: a.limit ?? 25, ...(a.op === "orders" ? { status: a.status ?? "any" } : a.status ? { status: a.status } : {}), ...(a.since ? { created_at_min: a.since } : {}) } }),
  shape: (data: unknown, a: { op: string }) => {
    const d = obj(data);
    if (a.op === "orders") return { items: list(d.orders).map((o) => ({ id: (o.id ?? null) as number | null, name: (o.name ?? null) as string | null, created_at: (o.created_at ?? null) as string | null, total: Number(o.total_price ?? 0), currency: (o.currency ?? null) as string | null, paid: (o.financial_status ?? null) as string | null, fulfilled: (o.fulfillment_status ?? null) as string | null, customer: [at(o, "customer.first_name"), at(o, "customer.last_name")].filter(Boolean).join(" ") || null, items: list(o.line_items).length })) };
    if (a.op === "products") return { items: list(d.products).map((p) => ({ id: (p.id ?? null) as number | null, title: (p.title ?? null) as string | null, status: (p.status ?? null) as string | null, vendor: (p.vendor ?? null) as string | null, price: Number(list(p.variants)[0]?.price ?? 0), inventory: list(p.variants).reduce((n, v) => n + Number(v.inventory_quantity ?? 0), 0) })) };
    return { items: list(d.customers).map((c) => ({ id: (c.id ?? null) as number | null, name: [c.first_name, c.last_name].filter(Boolean).join(" ") || null, orders: Number(c.orders_count ?? 0), spent: Number(c.total_spent ?? 0) })) };
  },
};

const stripe: TypedRead = {
  tool: "stripe.read",
  service: "stripe",
  args: z.object({ op: z.enum(["charges", "customers", "invoices", "payouts", "subscriptions", "balance"]), limit: LIMIT }),
  summary: "Read the owner's Stripe account, in test mode only: charges, customers, invoices, payouts, subscriptions or the balance. Amounts in major units (12.5 for 1250 cents).",
  signature:
    'tools.stripe.read({ op: "charges" | "customers" | "invoices" | "payouts" | "subscriptions" | "balance", limit?: number }): Promise<{ items: Array<Record<string, string | number | boolean | null>> }> // each with id, amount, currency, status and created (a date) where it has them; balance: { available, pending, currency }',
  outside: "a Stripe account",
  verb: "read your Stripe account",
  request: (a: { op: string; limit?: number }) => (a.op === "balance" ? { method: "GET", path: "/balance" } : { method: "GET", path: `/${a.op}`, query: { limit: a.limit ?? 25 } }),
  shape: (data: unknown, a: { op: string }) => {
    const major = (n: unknown) => (typeof n === "number" ? n / 100 : null);
    if (a.op === "balance") {
      const sum = (k: string) => list(obj(data)[k]).reduce((n, b) => n + Number(b.amount ?? 0), 0) / 100;
      return { items: [{ available: sum("available"), pending: sum("pending"), currency: String(list(obj(data).available)[0]?.currency ?? "usd") }] };
    }
    return {
      items: list(obj(data).data).map((x) => ({
        id: String(x.id ?? ""),
        amount: major(x.amount ?? x.amount_due ?? x.amount_paid ?? null),
        currency: (x.currency ?? null) as string | null,
        status: (x.status ?? null) as string | null,
        created: typeof x.created === "number" ? new Date(x.created * 1000).toISOString() : null,
        description: cut(x.description ?? x.name ?? null, 300) as string | null,
        customer: (typeof x.customer === "string" ? x.customer : null) as string | null,
      })),
    };
  },
};

export const CHAINS = { ethereum: 1, sepolia: 11155111, base: 8453, "base-sepolia": 84532 } as const;

const etherscan: TypedRead = {
  tool: "etherscan.read",
  service: "etherscan",
  args: z.object({ op: z.enum(["transactions", "token_transfers", "balance"]), address: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "an address is 0x and 40 hex characters"), chain: z.enum(["ethereum", "sepolia", "base", "base-sepolia"]), limit: LIMIT }),
  summary: "Read an address on Ethereum or Base (Etherscan and Basescan): its newest transactions, token transfers, or its balance in ether.",
  signature:
    'tools.etherscan.read({ op: "transactions" | "token_transfers" | "balance", address: string, chain: "ethereum" | "sepolia" | "base" | "base-sepolia", limit?: number }): Promise<{ items: Array<{ hash: string, from: string, to: string, value: number, token: string, time: string }> } | { balance: number }> // newest first; value in ether or in the token\'s own units',
  outside: "a blockchain explorer",
  verb: "read the chain",
  request: (a: { op: string; address: string; chain: keyof typeof CHAINS; limit?: number }) => ({
    method: "GET",
    path: "",
    query: { chainid: CHAINS[a.chain], module: "account", action: a.op === "balance" ? "balance" : a.op === "transactions" ? "txlist" : "tokentx", address: a.address, ...(a.op === "balance" ? { tag: "latest" } : { page: 1, offset: a.limit ?? 25, sort: "desc" }) },
  }),
  shape: (data: unknown, a: { op: string }) => {
    const d = obj(data);
    if (a.op === "balance") return { balance: Number(d.result ?? 0) / 1e18 };
    return {
      items: list(d.result).map((t) => {
        const decimals = Number(t.tokenDecimal ?? 18);
        return { hash: String(t.hash ?? ""), from: String(t.from ?? ""), to: String(t.to ?? ""), value: Number(t.value ?? 0) / 10 ** decimals, token: String(t.tokenSymbol ?? (a.op === "transactions" ? "ETH" : "")), time: t.timeStamp ? new Date(Number(t.timeStamp) * 1000).toISOString() : "" };
      }),
    };
  },
};

const coingecko: TypedRead = {
  tool: "coingecko.read",
  service: "coingecko",
  args: z.object({ coins: z.array(z.string().regex(/^[a-z0-9-]{1,60}$/, "a coin is CoinGecko's id for it, like bitcoin")).min(1).max(25), currency: z.string().regex(/^[a-z]{3,5}$/).optional() }),
  summary: "Read coins' prices from CoinGecko (no key), by CoinGecko's id for each (bitcoin, ethereum): the price, its change over 24 hours and its market cap.",
  signature: "tools.coingecko.read({ coins: string[], currency?: string }): Promise<{ prices: Array<{ coin: string, price: number, change_24h: number, market_cap: number }> }> // currency usd unless given; a coin CoinGecko doesn't know is left out",
  outside: "a price feed",
  verb: "read the prices",
  request: (a: { coins: string[]; currency?: string }) => ({ method: "GET", path: "/simple/price", query: { ids: a.coins.join(","), vs_currencies: a.currency ?? "usd", include_24hr_change: "true", include_market_cap: "true" } }),
  shape: (data: unknown, a: { currency?: string }) => {
    const c = a.currency ?? "usd";
    return { prices: Object.entries(obj(data)).map(([coin, v]) => ({ coin, price: Number(obj(v)[c] ?? 0), change_24h: Number(obj(v)[`${c}_24h_change`] ?? 0), market_cap: Number(obj(v)[`${c}_market_cap`] ?? 0) })) };
  },
};

export const TYPED_READS: TypedRead[] = [github, tally, airtable, notion, linear, shopify, stripe, etherscan, coingecko];

export function typedRead(tool: string): TypedRead | null {
  return TYPED_READS.find((t) => t.tool === tool) ?? null;
}

// A call's key on the test bench: the tool and its arguments, written the
// same way whatever order their fields came in, so a stand-in answers the
// exact call the code makes.
export function callKey(tool: string, args: unknown): string {
  const norm = (x: unknown): unknown => (Array.isArray(x) ? x.map(norm) : x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().filter((k) => (x as Record<string, unknown>)[k] !== undefined).map((k) => [k, norm((x as Record<string, unknown>)[k])])) : x);
  return `${tool} ${JSON.stringify(norm(args ?? null))}`;
}
