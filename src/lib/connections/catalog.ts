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
  // What a valid answer looks like, and why one that isn't is refused.
  pattern?: string;
  patternWhy?: string;
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
  query?: Record<string, string>;
  body?: unknown;
  label?: string;
  text?: string;
  // Answers that mean the key works though the call was refused (a key
  // that may only send, asked to list): a status and words in its body.
  accept?: { status: number; match: string; text: string }[];
  // A 2xx answer that still means the key doesn't work (an API that says
  // so in its body): words in its body.
  failsWhen?: string;
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
  // What to check when a key is turned down, after "check".
  turnedDown?: string;
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
  // Reads that are POSTs (a GraphQL query, a JSON-RPC call): service.request
  // may POST to it, never a mutation or a call that sends.
  postReads?: "graphql" | "jsonrpc";
  // Writes go form-encoded, not as JSON (Twilio).
  form?: boolean;
  // Where in the service to paste an agent's own address, for it to post
  // there (an Incoming webhook): the place, in plain words.
  webhookHow?: string;
  // How a write is made, for the planner: what to send where.
  sendHow?: string;
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
    turnedDown: "it can read forms and responses, or make a new one",
    keyUrl: "https://admin.typeform.com/user/tokens",
    keyHow: "In Typeform, open your account's Personal tokens and generate one that can read forms and responses.",
    reads: "The answers to the forms you give your agents, each new answer once.",
    writes: null,
    webhookHow: "In Typeform, open the form's Connect tab, then Webhooks, and press Add a webhook: paste it as the Endpoint, save it, and switch the webhook on.",
    tools: ["typeform.read"],
  },
  {
    id: "discord",
    name: "Discord",
    category: "messaging",
    auth: "webhook_url",
    aliases: ["discord"],
    fields: [{ key: "url", label: "Webhook URL", secret: true, placeholder: "https://discord.com/api/webhooks/...", pattern: "^https://(?:ptb\\.|canary\\.)?discord(?:app)?\\.com/api/webhooks/\\d+/[\\w-]+$", patternWhy: "That isn't a Discord webhook's address: copy it from the channel's Integrations, Webhooks." }],
    base: "https://discord.com/api/webhooks",
    hosts: ["discord.com"],
    place: { in: "url" },
    check: { method: "GET", path: "", label: "name", text: "a webhook" },
    turnedDown: "the webhook still exists, or copy its address again",
    keyUrl: "https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks",
    keyHow: "In the Discord channel's settings, open Integrations, then Webhooks, make one and copy its URL.",
    reads: "Nothing: a webhook only posts.",
    writes: "Posts messages in the one channel the webhook belongs to.",
    tools: [],
    sendHow: 'service.send({ connection: "discord", body: { content } }): content is the message, at most 2000 characters.',
  },
  {
    id: "slack",
    name: "Slack",
    category: "messaging",
    auth: "bot_token",
    aliases: ["slack"],
    fields: [{ key: "token", label: "Bot token", secret: true, placeholder: "xoxb-...", pattern: "^xox[bp]-", patternWhy: "A Slack bot token starts with xoxb-." }],
    base: "https://slack.com/api",
    hosts: ["slack.com"],
    place: { in: "header", name: "authorization", prefix: "Bearer " },
    check: { method: "GET", path: "/auth.test", label: "team", text: "your workspace", failsWhen: '"ok":false' },
    keyUrl: "https://api.slack.com/apps",
    keyHow: "Make a Slack app, give its bot the scopes it needs (chat:write to post, channels:history to read), install it and copy the Bot User OAuth Token.",
    reads: "Messages in the channels its bot is in (conversations.history).",
    writes: "Posts in the channels its bot is in (chat.postMessage).",
    tools: [],
    sendHow: 'service.send({ connection: "slack", path: "/chat.postMessage", body: { channel, text } }): channel is a setting.',
  },
  {
    id: "resend",
    name: "Email (Resend)",
    short: "Resend",
    category: "messaging",
    auth: "api_key",
    aliases: ["email", "e-mail", "resend", "mail"],
    fields: [{ key: "key", label: "API key", secret: true, placeholder: "re_...", pattern: "^re_", patternWhy: "A Resend API key starts with re_." }],
    base: "https://api.resend.com",
    hosts: ["api.resend.com"],
    place: { in: "header", name: "authorization", prefix: "Bearer " },
    check: { method: "GET", path: "/domains", text: "your account", accept: [{ status: 401, match: "restricted_api_key", text: "a key that sends" }] },
    keyUrl: "https://resend.com/api-keys",
    keyHow: "In Resend, open API Keys and make one (Sending access is enough to send).",
    reads: "Your sending domains.",
    writes: "Sends email from a domain you verified in Resend.",
    tools: [],
    sendHow: 'service.send({ connection: "resend", path: "/emails", body: { from, to, subject, text } }): from and to are settings.',
  },
  {
    id: "twilio",
    name: "SMS (Twilio)",
    short: "Twilio",
    category: "messaging",
    auth: "api_key",
    aliases: ["sms", "text message", "twilio"],
    fields: [
      { key: "account", label: "Account SID", secret: false, placeholder: "AC...", pattern: "^AC[0-9a-fA-F]{32}$", patternWhy: "A Twilio Account SID starts with AC and has 34 characters." },
      { key: "token", label: "Auth token", secret: true },
    ],
    base: "https://api.twilio.com/2010-04-01/Accounts/{account}",
    hosts: ["api.twilio.com"],
    place: { in: "basic", user: "account" },
    check: { method: "GET", path: "/Messages.json", query: { PageSize: "1" }, text: "your account" },
    keyUrl: "https://console.twilio.com/",
    keyHow: "On the Twilio Console's front page, copy the Account SID and the Auth token.",
    reads: "The text messages your number sent and got (Messages.json).",
    writes: "Sends text messages from your Twilio number.",
    tools: [],
    form: true,
    sendHow: 'service.send({ connection: "twilio", path: "/Messages.json", body: { To, From, Body } }): To and From are settings.',
  },
  {
    id: "tally",
    name: "Tally",
    category: "forms",
    auth: "api_key",
    aliases: ["tally"],
    fields: [{ key: "key", label: "API key", secret: true, placeholder: "tly-..." }],
    base: "https://api.tally.so",
    hosts: ["api.tally.so"],
    place: { in: "header", name: "authorization", prefix: "Bearer " },
    check: { method: "GET", path: "/users/me", label: "fullName", text: "your account" },
    keyUrl: "https://tally.so/settings/api-keys",
    keyHow: "In Tally, open Settings, then API keys, and make one.",
    reads: "The answers to your forms.",
    writes: null,
    webhookHow: "In Tally, open the form's Integrations, choose Webhooks and press Connect: paste it as the Endpoint URL and save.",
    tools: ["tally.read"],
  },
  {
    id: "airtable",
    name: "Airtable",
    category: "forms",
    auth: "bearer",
    aliases: ["airtable"],
    fields: [{ key: "token", label: "Personal access token", secret: true, placeholder: "pat...", pattern: "^pat", patternWhy: "An Airtable personal access token starts with pat." }],
    base: "https://api.airtable.com/v0",
    hosts: ["api.airtable.com"],
    place: { in: "header", name: "authorization", prefix: "Bearer " },
    check: { method: "GET", path: "/meta/whoami", text: "your account" },
    keyUrl: "https://airtable.com/create/tokens",
    keyHow: "In Airtable, open the developer hub's Personal access tokens, make one with data.records:read (and :write to write) for the bases it uses.",
    reads: "The records of the tables you give it.",
    writes: "Adds and changes records.",
    tools: ["airtable.read"],
    sendHow: 'service.send({ connection: "airtable", path: "/<base>/<table>", body: { records: [{ fields }] } }): base and table are settings.',
  },
  {
    id: "notion",
    name: "Notion",
    category: "forms",
    auth: "bearer",
    aliases: ["notion"],
    fields: [{ key: "token", label: "Integration secret", secret: true, placeholder: "ntn_..." }],
    base: "https://api.notion.com/v1",
    hosts: ["api.notion.com"],
    place: { in: "header", name: "authorization", prefix: "Bearer " },
    headers: { "notion-version": "2022-06-28" },
    check: { method: "GET", path: "/users/me", label: "name", text: "your integration" },
    keyUrl: "https://www.notion.so/profile/integrations",
    keyHow: "In Notion, make an internal integration, copy its secret, then share each database with it (Connections on the database's menu).",
    reads: "The databases you share with the integration.",
    writes: "Adds pages to those databases.",
    webhookHow: "In Notion, open your integration's settings (Profile, Integrations), then Webhooks, and create a subscription: paste it as the Webhook URL and pick the events.",
    tools: ["notion.read"],
    sendHow: 'service.send({ connection: "notion", path: "/pages", body: { parent: { database_id }, properties } }): database_id is a setting.',
  },
  {
    id: "github",
    name: "GitHub",
    category: "work",
    auth: "bearer",
    aliases: ["github", "git hub", "githubs", "repo", "repos", "repository", "repositories", "pull request", "pull requests", "commits"],
    fields: [{ key: "token", label: "Personal access token", secret: true, optional: true, placeholder: "github_pat_..." }],
    base: "https://api.github.com",
    hosts: ["api.github.com"],
    place: { in: "header", name: "authorization", prefix: "Bearer " },
    headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    check: { method: "GET", path: "/user", label: "login" },
    keyUrl: "https://github.com/settings/personal-access-tokens",
    keyHow: "Public repositories need no key. For private ones, make a fine-grained token with read access to those repositories.",
    reads: "Commits, pull requests, issues and their changes. Public repositories need no key.",
    writes: "Opens issues and adds comments.",
    webhookHow: "In GitHub, open the repository's Settings, then Webhooks, and press Add webhook: paste it as the Payload URL, set Content type to application/json, pick the events to send, and press Add webhook.",
    tools: ["github.read"],
    sendHow: 'service.send({ connection: "github", path: "/repos/<owner>/<repo>/issues", body: { title, body } }): the repository is a setting.',
  },
  {
    id: "gitlab",
    name: "GitLab",
    category: "work",
    auth: "api_key",
    aliases: ["gitlab", "git lab", "merge request", "merge requests"],
    fields: [{ key: "token", label: "Personal access token", secret: true, placeholder: "glpat-..." }],
    base: "https://gitlab.com/api/v4",
    hosts: ["gitlab.com"],
    place: { in: "header", name: "private-token" },
    check: { method: "GET", path: "/user", label: "username" },
    keyUrl: "https://gitlab.com/-/user_settings/personal_access_tokens",
    keyHow: "In GitLab, open Access tokens and make one with read_api (and api to write).",
    reads: "Projects, commits, merge requests and issues (GET /projects/:id/...).",
    writes: "Opens issues and adds notes.",
    webhookHow: "In GitLab, open the project's Settings, then Webhooks, and press Add new webhook: paste it as the URL, tick the events to send, and press Add webhook.",
    tools: [],
    sendHow: 'service.send({ connection: "gitlab", path: "/projects/<id>/issues", body: { title, description } }).',
  },
  {
    id: "linear",
    name: "Linear",
    category: "work",
    auth: "api_key",
    aliases: ["linear"],
    fields: [{ key: "key", label: "API key", secret: true, placeholder: "lin_api_...", pattern: "^lin_api_", patternWhy: "A Linear API key starts with lin_api_." }],
    base: "https://api.linear.app",
    hosts: ["api.linear.app"],
    place: { in: "header", name: "authorization" },
    check: { method: "POST", path: "/graphql", body: { query: "{ viewer { name } }" }, label: "data.viewer.name", failsWhen: '"errors"' },
    keyUrl: "https://linear.app/settings/account/security",
    keyHow: "In Linear, open Settings, Security and access, and make a personal API key.",
    reads: "Issues, by team and state.",
    writes: "Creates and updates issues.",
    webhookHow: "In Linear, open Settings, then API, and under Webhooks press New webhook: paste it as the URL, pick the teams and events, and save.",
    tools: ["linear.read"],
    postReads: "graphql",
    sendHow: 'service.send({ connection: "linear", path: "/graphql", body: { query: "mutation ...", variables } }).',
  },
  {
    id: "jira",
    name: "Jira",
    category: "work",
    auth: "api_key",
    aliases: ["jira", "atlassian"],
    fields: [
      { key: "site", label: "Site name", secret: false, placeholder: "yourteam (from yourteam.atlassian.net)", pattern: "^[a-z0-9][a-z0-9-]{0,62}$", patternWhy: "The site is the first part of your Jira address: yourteam for yourteam.atlassian.net." },
      { key: "email", label: "Your Atlassian email", secret: false },
      { key: "token", label: "API token", secret: true },
    ],
    base: "https://{site}.atlassian.net/rest/api/3",
    hosts: ["{site}.atlassian.net"],
    place: { in: "basic", user: "email" },
    check: { method: "GET", path: "/myself", label: "displayName" },
    keyUrl: "https://id.atlassian.com/manage-profile/security/api-tokens",
    keyHow: "In your Atlassian account's Security, make an API token.",
    reads: "Issues, by JQL search (GET /search/jql?jql=...).",
    writes: "Creates issues and adds comments.",
    webhookHow: "In Jira, open Settings (System), then WebHooks, and press Create a WebHook: paste it as the URL, pick the events, and save.",
    tools: [],
    sendHow: 'service.send({ connection: "jira", path: "/issue", body: { fields } }).',
  },
  {
    id: "shopify",
    name: "Shopify",
    category: "commerce",
    auth: "api_key",
    aliases: ["shopify", "my shop", "store orders"],
    fields: [
      { key: "shop", label: "Shop name", secret: false, placeholder: "yourshop (from yourshop.myshopify.com)", pattern: "^[a-z0-9][a-z0-9-]{0,62}$", patternWhy: "The shop is the first part of its myshopify.com address: yourshop for yourshop.myshopify.com." },
      { key: "token", label: "Admin API access token", secret: true, placeholder: "shpat_...", pattern: "^shpat_", patternWhy: "A Shopify Admin API access token starts with shpat_." },
    ],
    base: "https://{shop}.myshopify.com/admin/api/2026-01",
    hosts: ["{shop}.myshopify.com"],
    place: { in: "header", name: "x-shopify-access-token" },
    check: { method: "GET", path: "/shop.json", label: "shop.name" },
    keyUrl: "https://help.shopify.com/en/manual/apps/app-types/custom-apps",
    keyHow: "In your Shopify admin, open Settings, Apps, Develop apps, make an app with read_orders and read_products, install it and copy the Admin API access token.",
    reads: "Orders, products and customers.",
    writes: "Changes orders and products.",
    webhookHow: "In your Shopify admin, open Settings, then Notifications, Webhooks, and press Create webhook: pick the event, choose JSON, paste it as the URL and save.",
    tools: ["shopify.read"],
  },
  {
    id: "stripe",
    name: "Stripe",
    category: "commerce",
    auth: "api_key",
    aliases: ["stripe"],
    fields: [{ key: "key", label: "Test secret key", secret: true, placeholder: "sk_test_...", pattern: "^(?:sk|rk)_test_", patternWhy: "Only test keys are taken here (sk_test_ or rk_test_): a live key never is." }],
    base: "https://api.stripe.com/v1",
    hosts: ["api.stripe.com"],
    place: { in: "header", name: "authorization", prefix: "Bearer " },
    check: { method: "GET", path: "/balance", text: "test mode" },
    keyUrl: "https://dashboard.stripe.com/test/apikeys",
    keyHow: "In Stripe's dashboard, in test mode, open Developers, API keys, and copy the secret key (or make a restricted one that reads).",
    reads: "Charges, customers, invoices, payouts and subscriptions, in test mode only.",
    writes: null,
    webhookHow: "In Stripe's dashboard, in test mode, open Developers, then Webhooks, and add an endpoint (a destination): paste it as the Endpoint URL and pick the events to send.",
    tools: ["stripe.read"],
  },
  {
    id: "gumroad",
    name: "Gumroad",
    category: "commerce",
    auth: "bearer",
    aliases: ["gumroad"],
    fields: [{ key: "token", label: "Access token", secret: true }],
    base: "https://api.gumroad.com/v2",
    hosts: ["api.gumroad.com"],
    place: { in: "header", name: "authorization", prefix: "Bearer " },
    check: { method: "GET", path: "/user", label: "user.name", failsWhen: '"success":false' },
    keyUrl: "https://app.gumroad.com/settings/advanced#application-form",
    keyHow: "In Gumroad, open Settings, Advanced, make an application and generate its access token.",
    reads: "Your products and sales (GET /sales, /products).",
    writes: null,
    webhookHow: "In Gumroad, open Settings, then Advanced, and paste it as the Ping endpoint: Gumroad posts each sale there.",
    tools: [],
  },
  {
    id: "lemonsqueezy",
    name: "Lemon Squeezy",
    category: "commerce",
    auth: "bearer",
    aliases: ["lemon squeezy", "lemonsqueezy"],
    fields: [{ key: "key", label: "API key", secret: true }],
    base: "https://api.lemonsqueezy.com/v1",
    hosts: ["api.lemonsqueezy.com"],
    place: { in: "header", name: "authorization", prefix: "Bearer " },
    headers: { accept: "application/vnd.api+json" },
    check: { method: "GET", path: "/users/me", label: "data.attributes.name" },
    keyUrl: "https://app.lemonsqueezy.com/settings/api",
    keyHow: "In Lemon Squeezy, open Settings, API, and make a key.",
    reads: "Orders, subscriptions and products (GET /orders, /subscriptions).",
    writes: null,
    webhookHow: "In Lemon Squeezy, open Settings, then Webhooks, and press the plus: paste it as the Callback URL, pick the events, and save.",
    tools: [],
  },
  {
    id: "etherscan",
    name: "Etherscan and Basescan",
    short: "Etherscan",
    category: "crypto",
    auth: "api_key",
    aliases: ["etherscan", "basescan", "wallet transactions", "on-chain", "onchain"],
    fields: [{ key: "key", label: "API key", secret: true }],
    base: "https://api.etherscan.io/v2/api",
    hosts: ["api.etherscan.io"],
    place: { in: "query", name: "apikey" },
    check: { method: "GET", path: "", query: { chainid: "1", module: "stats", action: "ethprice" }, text: "your key", failsWhen: '"status":"0"' },
    keyUrl: "https://etherscan.io/myapikey",
    keyHow: "Sign in at etherscan.io and add an API key: one key reads Ethereum and Base (Basescan) alike.",
    reads: "An address's transactions, token transfers and balance, on Ethereum and Base.",
    writes: null,
    tools: ["etherscan.read"],
  },
  {
    id: "coingecko",
    name: "CoinGecko",
    category: "crypto",
    auth: "none",
    aliases: ["coingecko", "coin gecko", "crypto price", "token price", "bitcoin price", "eth price"],
    fields: [],
    base: "https://api.coingecko.com/api/v3",
    hosts: ["api.coingecko.com"],
    check: null,
    keyUrl: null,
    keyHow: "Nothing to connect: prices are public.",
    reads: "Coin prices and market data. No key.",
    writes: null,
    tools: ["coingecko.read"],
  },
  {
    id: "dexscreener",
    name: "DexScreener",
    category: "crypto",
    auth: "none",
    aliases: ["dexscreener", "dex screener", "liquidity pool", "dex pair"],
    fields: [],
    base: "https://api.dexscreener.com",
    hosts: ["api.dexscreener.com"],
    check: null,
    keyUrl: null,
    keyHow: "Nothing to connect: pairs are public.",
    reads: "Trading pairs, their prices and liquidity (GET /latest/dex/search?q=, /tokens/v1/<chain>/<address>). No key.",
    writes: null,
    tools: [],
  },
  {
    id: "alchemy",
    name: "Alchemy",
    category: "crypto",
    auth: "api_key",
    aliases: ["alchemy", "rpc"],
    fields: [
      { key: "network", label: "Network", secret: false, choices: ["eth-mainnet", "base-mainnet", "base-sepolia", "eth-sepolia", "polygon-mainnet", "arb-mainnet", "opt-mainnet"] },
      { key: "key", label: "API key", secret: true },
    ],
    base: "https://{network}.g.alchemy.com/v2/{key}",
    hosts: ["{network}.g.alchemy.com"],
    place: { in: "url" },
    check: { method: "POST", path: "", body: { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }, text: "your app", failsWhen: '"error"' },
    keyUrl: "https://dashboard.alchemy.com/",
    keyHow: "In Alchemy's dashboard, make an app on the network it reads and copy its API key.",
    reads: "The chain itself, by JSON-RPC (eth_getBalance, eth_call, eth_getLogs, alchemy_getTokenBalances).",
    writes: null,
    webhookHow: "In Alchemy's dashboard, open Webhooks (Notify) and create one: pick what it watches and paste it as the Webhook URL.",
    tools: [],
    postReads: "jsonrpc",
  },
  {
    id: "calcom",
    name: "Cal.com",
    category: "scheduling",
    auth: "api_key",
    aliases: ["cal.com", "calcom", "cal com"],
    fields: [{ key: "key", label: "API key", secret: true, placeholder: "cal_live_..." }],
    base: "https://api.cal.com/v2",
    hosts: ["api.cal.com"],
    place: { in: "header", name: "authorization", prefix: "Bearer " },
    headers: { "cal-api-version": "2024-08-13" },
    check: { method: "GET", path: "/me", label: "data.username" },
    keyUrl: "https://app.cal.com/settings/developer/api-keys",
    keyHow: "In Cal.com, open Settings, Developer, API keys, and make one.",
    reads: "Your bookings (GET /bookings).",
    writes: "Cancels or reschedules bookings.",
    webhookHow: "In Cal.com, open Settings, then Developer, Webhooks, and press New: paste it as the Subscriber URL, pick the events, and save.",
    tools: [],
  },
  {
    id: "calendly",
    name: "Calendly",
    category: "scheduling",
    auth: "bearer",
    aliases: ["calendly"],
    fields: [{ key: "token", label: "Personal access token", secret: true }],
    base: "https://api.calendly.com",
    hosts: ["api.calendly.com"],
    place: { in: "header", name: "authorization", prefix: "Bearer " },
    check: { method: "GET", path: "/users/me", label: "resource.name" },
    keyUrl: "https://calendly.com/integrations/api_webhooks",
    keyHow: "In Calendly, open Integrations, API and webhooks, and generate a personal access token.",
    reads: "Your scheduled events and who booked them (GET /scheduled_events?user=...).",
    writes: null,
    tools: [],
  },
  {
    id: "hubspot",
    name: "HubSpot",
    category: "scheduling",
    auth: "bearer",
    aliases: ["hubspot", "crm"],
    fields: [{ key: "token", label: "Private app token", secret: true, placeholder: "pat-..." }],
    base: "https://api.hubapi.com",
    hosts: ["api.hubapi.com"],
    place: { in: "header", name: "authorization", prefix: "Bearer " },
    check: { method: "GET", path: "/account-info/v3/details", label: "portalId" },
    keyUrl: "https://developers.hubspot.com/docs/api/private-apps",
    keyHow: "In HubSpot, open Settings, Integrations, Private apps, make one with the CRM scopes it needs and copy its token.",
    reads: "Contacts, companies and deals (GET /crm/v3/objects/contacts).",
    writes: "Creates and updates contacts and deals.",
    tools: [],
    sendHow: 'service.send({ connection: "hubspot", path: "/crm/v3/objects/contacts", body: { properties } }).',
  },
  {
    id: "custom",
    name: "Custom API",
    category: "custom",
    auth: "api_key",
    aliases: ["custom api", "my api", "own api"],
    fields: [
      { key: "base", label: "Address", secret: false, placeholder: "https://api.example.com", pattern: "^https://[a-z0-9.-]+(?::\\d+)?(?:/[\\w./-]*)?$", patternWhy: "The address is https, a public host and a path (https://api.example.com/v1)." },
      { key: "header", label: "Header the key goes in", secret: false, optional: true, placeholder: "authorization" },
      { key: "prefix", label: "Before the key", secret: false, optional: true, placeholder: "Bearer" },
      { key: "key", label: "Key", secret: true, optional: true },
      { key: "check", label: "A path to check it with", secret: false, optional: true, placeholder: "/me" },
    ],
    base: "{base}",
    hosts: ["{base}"],
    check: null,
    keyUrl: null,
    keyHow: "Any service not listed here, by its https address and your key for it (from that service): public hosts only.",
    reads: "Whatever the service's API answers at the paths your agent asks.",
    writes: "Whatever the service's API takes, with writing on.",
    tools: [],
    sendHow: 'service.send({ connection: "custom", path, body }).',
  },
  {
    id: "webhook",
    name: "Incoming webhook",
    category: "custom",
    auth: "none",
    aliases: ["webhook", "incoming webhook", "zapier", "make.com", "when something posts"],
    fields: [],
    base: "https://boardofserv.25th.dev/api/hooks",
    hosts: ["boardofserv.25th.dev"],
    check: null,
    keyUrl: null,
    keyHow: "Nothing to connect: each agent that starts on one gets its own private address, shown on its page once it is set up.",
    reads: "What is posted to the agent's private address: each post starts a job.",
    writes: null,
    tools: [],
  },
  {
    id: "rss",
    name: "RSS",
    category: "forms",
    auth: "none",
    aliases: ["rss", "feed", "atom feed", "blog posts", "news feed"],
    fields: [],
    base: "https://feeds.example.com",
    hosts: ["*"],
    check: null,
    keyUrl: null,
    keyHow: "Nothing to connect: a feed's address is a setting the agent asks for.",
    reads: 'A feed\'s newest items (service.request({ connection: "rss", url })), each with its title, link, date and summary. No key.',
    writes: null,
    tools: [],
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
// service with nothing to connect, or whose only field is a key for more
// (a public repository needs none), doesn't.
export function needsConnecting(e: ServiceEntry): boolean {
  return e.auth !== "none" && (e.fields.length === 0 || e.fields.some((f) => !f.optional));
}

// The service a typed tool reads, if it is one of the catalog's.
export function serviceOfTool(tool: string): ServiceEntry | null {
  return CATALOG.find((e) => e.tools.includes(tool)) ?? null;
}

// The services a maker's words name, by id, in the catalog's order: each
// by its name or one of its aliases, as whole words.
export function servicesIn(text: string): string[] {
  const t = ` ${text.toLowerCase().replace(/[^a-z0-9.@ -]+/g, " ")} `;
  return CATALOG.filter((e) => [e.name.toLowerCase(), ...e.aliases].some((a) => t.includes(` ${a} `) || t.includes(` ${a}s `) || t.includes(` ${a}. `))).map((e) => e.id);
}
