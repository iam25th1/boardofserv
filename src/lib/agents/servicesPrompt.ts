import { CATALOG } from "../connections/catalog";

// The catalog as the planner reads it: every service an agent can reach
// through a connection its owner makes, by id, with what it reads and
// writes and the tool that reads it, and the rules for reaching one. The
// services the maker named (or answered about) get how to write to them
// too. Telegram, Google Sheets and Typeform have paragraphs of their own.

const OWN = ["telegram", "google", "typeform"];

export function servicesPrompt(named: readonly string[] = []): string {
  const lines = CATALOG.filter((e) => !OWN.includes(e.id)).map((e) => {
    const parts = [`- ${e.id} (${e.name}): reads ${e.reads.replace(/\.$/, "")}`];
    if (e.writes) parts.push(`writes: ${e.writes.replace(/\.$/, "")}`);
    if (e.tools.length) parts.push(`read it with ${e.tools.join(", ")}`);
    if (e.auth === "none" && e.id !== "webhook") parts.push("no key");
    if (named.includes(e.id) && e.sendHow) parts.push(`to write: ${e.sendHow}`);
    return parts.join("; ");
  });
  return [
    "Services the owner can connect, by id:",
    ...lines,
    "Reach a service only through its own tool: its typed read where it has one (github.read for a GitHub repository, public ones with no key), else service.request with connection its id and a path under its address. Write to it with service.send, a declared action. Never web.fetch a service's API and never put a key, token or password in a step, a setting or a rule: the owner connects the service on Connections and the server adds the key to each call.",
    "List in services every service it reaches with service.request or service.send, by id (its typed reads name their own).",
    "Never plan a step for a service that isn't listed here. One the maker named that isn't listed is reached through custom (Custom API, an https address and key the owner gives) only when the maker chose that; otherwise leave it out.",
    "What it works on and who it tells are settings the steps read, never written into a step: repositories (a list setting of owner/name, like vercel/next.js), addresses, links, forms, channels, recipients, coins, wallets and the numbers it compares against (a rule).",
    "A job that starts when something is posted to it (another app's webhook, a form tool, Zapier) has one trigger of kind webhook, and what was posted is its trigger value; the owner gets the private address to post to once it is set up.",
  ].join("\n");
}
