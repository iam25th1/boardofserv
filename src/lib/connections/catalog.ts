// The catalog of services an owner can connect, and agents reach through
// those connections. Each service is one entry: what it is (its category),
// how it is connected (its auth: a key or token pasted once, a webhook's
// address, a link made in Telegram, Google's own sign-in, or nothing at
// all), the only hosts a call through it may reach, the one cheap call that
// checks a key when it is saved, where to get a key, and what it reads and
// writes, in plain words. The server adds a connection's secret to a call
// (connections/request.ts); agents only ever name the connection.
//
// Plain data with no server imports: the Connections page reads it too.

export const CATEGORIES = [
  { id: "messaging", name: "Messages" },
  { id: "forms", name: "Forms and data" },
  { id: "work", name: "Code and work" },
  { id: "commerce", name: "Shops and payments" },
  { id: "crypto", name: "Crypto" },
  { id: "scheduling", name: "Scheduling and customers" },
  { id: "custom", name: "Your own" },
] as const;
export type Category = (typeof CATEGORIES)[number]["id"];

// How a service is connected:
// - chat: the owner links their own Telegram chat with a code (telegram/).
// - oauth: the service's own sign-in (Google).
// - api_key, bearer, bot_token: a key or token the owner pastes once.
// - webhook_url: the address the service gave them, which is the secret.
// - none: nothing to connect; anyone can read it.
export const AUTH_KINDS = ["chat", "oauth", "api_key", "bearer", "bot_token", "webhook_url", "none"] as const;
export type AuthKind = (typeof AUTH_KINDS)[number];

// One thing the owner pastes or picks when connecting. A secret field is
// kept encrypted and never shown again; the others (a shop's name, an
// account id) describe the connection and may be shown to its owner.
export interface Field {
  key: string;
  label: string;
  secret: boolean;
  placeholder?: string;
  // What a valid answer looks like.
  pattern?: string;
  // Not needed (a public repository needs no key).
  optional?: boolean;
  // The answers to pick from.
  choices?: string[];
}

// Where a call's secret goes: a header (with its prefix), the query
// string, HTTP basic auth (user names the field that is the user, and the
// key is the password), or the address itself (a webhook's, or a key in
// the base's path).
export type Placement = { in: "header"; name: string; prefix?: string } | { in: "query"; name: string } | { in: "basic"; user: string } | { in: "url" };

// The cheap call that checks a connection when it is saved, and the field
// of its answer that names the account ("Connected as X"). label is a
// path into the JSON answer (data.viewer.name); text is said instead when
// the answer names nothing worth showing.
export interface Check {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  label?: string;
  text?: string;
}

export interface ServiceEntry {
  id: string;
  name: string;
  // Its name in a sentence, when that is shorter ("Connect Google").
  short?: string;
  category: Category;
  auth: AuthKind;
  // Words a maker uses for it, for finding it in what they said.
  aliases: string[];
  fields: Field[];
  // The base of every call; {field} takes a field's value.
  base: string;
  // The only hosts a call through it may reach ({field} as in base). A
  // redirect anywhere else is refused.
  hosts: string[];
  // Where its secret goes on a call.
  place?: Placement;
  // Headers every call carries (a version the API wants).
  headers?: Record<string, string>;
  check: Check | null;
  // Where to get a key, and how, in plain words.
  keyUrl: string | null;
  keyHow: string;
  reads: string;
  // What writing through it does, or null when it only reads.
  writes: string | null;
  // The typed tools that read it (an agent's step calls these by name).
  tools: string[];
  // Writing through it starts switched on: the owner's own chat and the
  // tabs they give each agent, as before the switch existed.
  writesOn?: boolean;
}

export const CATALOG: ServiceEntry[] = [
  {
    id: "telegram",
    name: "Telegram",
    category: "messaging",
    auth: "chat",
    aliases: ["telegram"],
    fields: [],
    base: "https://api.telegram.org",
    hosts: ["api.telegram.org"],
    check: null,
    keyUrl: null,
    keyHow: "Link your own chat: press Link Telegram and send the code to boardofserv's bot.",
    reads: "The messages you send your agents.",
    writes: "Messages and questions to you, in your own chat.",
    tools: ["telegram.send", "telegram.ask"],
    writesOn: true,
  },
  {
    id: "google",
    name: "Google Sheets",
    short: "Google",
    category: "forms",
    auth: "oauth",
    aliases: ["google sheets", "google sheet", "spreadsheet", "sheets"],
    fields: [],
    base: "https://sheets.googleapis.com",
    hosts: ["sheets.googleapis.com", "oauth2.googleapis.com"],
    check: null,
    keyUrl: null,
    keyHow: "Sign in with Google, then give each agent only the tabs it works on.",
    reads: "The tabs you give each agent.",
    writes: "Rows in the tabs you give each agent.",
    tools: ["sheets.read", "sheets.write", "sheets.update"],
    writesOn: true,
  },
  {
    id: "typeform",
    name: "Typeform",
    category: "forms",
    auth: "bearer",
    aliases: ["typeform"],
    fields: [{ key: "token", label: "Personal token", secret: true, placeholder: "tfp_..." }],
    base: "https://api.typeform.com",
    hosts: ["api.typeform.com"],
    place: { in: "header", name: "authorization", prefix: "Bearer " },
    check: { method: "GET", path: "/me", label: "alias", text: "your account" },
    keyUrl: "https://admin.typeform.com/user/tokens",
    keyHow: "In Typeform, open your account's Personal tokens and generate one that can read forms and responses.",
    reads: "The answers to the forms you give your agents, each new answer once.",
    writes: null,
    tools: ["typeform.read"],
  },
];

export const SERVICE_IDS = CATALOG.map((e) => e.id);

// A service's name in a sentence ("Connect Google first").
export function serviceName(id: string): string {
  const e = CATALOG.find((x) => x.id === id);
  return e ? (e.short ?? e.name) : id;
}

export function entryOf(id: string): ServiceEntry | null {
  return CATALOG.find((e) => e.id === id) ?? null;
}

// The services whose connections are kept in the vault: anything with
// something to connect.
export const CONNECTABLE_IDS = CATALOG.filter((e) => e.auth !== "none").map((e) => e.id);

// Whether an agent that uses it needs its owner to connect it first: a
// service with nothing to connect, or whose key is only for more (a
// public repository needs none), doesn't.
export function needsConnecting(e: ServiceEntry): boolean {
  return e.auth !== "none" && !e.fields.some((f) => f.secret && f.optional);
}

// The service a typed tool reads, if it is one of the catalog's.
export function serviceOfTool(tool: string): ServiceEntry | null {
  return CATALOG.find((e) => e.tools.includes(tool)) ?? null;
}
