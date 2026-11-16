import "server-only";
import { createHash } from "node:crypto";
import { pageText, guardedRequest, WebRefused, WebUnreachable, type Answered, type WebPolicy } from "../agents/runtime/webFetch";
import type { ServiceEntry } from "./catalog";

// One call to a service through an owner's connection. An agent's step
// only ever names the connection and what it wants (a path, a query, a
// body); the secret is added here, on the server, where the catalog says
// it goes, and never comes back: not in what the step gets, not in an
// error, not in a log line.
//
// - Only the entry's own hosts: a path can't name another, a field can't
//   move the call elsewhere, and a redirect anywhere else is refused.
// - https only, and never a private, local or reserved address (the
//   transport checks every address a name resolves to, as web.fetch does).
// - A time limit and a size limit; the answer is the service's data, which
//   the run treats as untrusted, like a web page.

export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type Method = (typeof METHODS)[number];

export interface ServiceCall {
  method: Method;
  // Under the entry's base ("/repos/a/b/commits"); "" is the base itself.
  path: string;
  query?: Record<string, string | number | boolean>;
  body?: unknown;
  // Sent form-encoded, not as JSON (Twilio).
  form?: boolean;
  // A whole address, for a service that reads from any public host (a
  // feed): its host is checked like any other.
  url?: string;
}

export interface ServiceAnswer {
  status: number;
  data: unknown;
  // What the service said of its rate limit (x-ratelimit-remaining and
  // x-ratelimit-reset, a time in seconds), when it said it.
  rate?: { remaining: number; reset: number };
}

function rateOf(headers: Record<string, string>): ServiceAnswer["rate"] {
  const remaining = Number(headers["x-ratelimit-remaining"]);
  const reset = Number(headers["x-ratelimit-reset"]);
  return headers["x-ratelimit-remaining"] !== undefined && Number.isFinite(remaining) ? { remaining, reset: Number.isFinite(reset) ? reset : 0 } : undefined;
}

export const MAX_REDIRECTS = 3;
export const MAX_ANSWER_TEXT = 50_000;

// The agent asked for something this connection may not do: its own logic.
export class ServiceRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceRefused";
  }
}

// The service couldn't be reached: worth another try later.
export class ServiceUnreachable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceUnreachable";
  }
}

// How a call goes out: the guarded transport on the server; tests answer
// it themselves.
export type Transport = (url: string, init: { method: string; headers: Record<string, string>; body?: string | null }) => Promise<Answered>;

export function guardedTransport(policy: WebPolicy = {}): Transport {
  return (url, init) => guardedRequest(url, init, policy);
}

// A transport made of a fetch (the tests' fake network), that never
// follows a redirect itself.
export function fetchTransport(fetchImpl: typeof fetch): Transport {
  return async (url, init) => {
    const res = await fetchImpl(url, { method: init.method, headers: init.headers, body: init.body ?? undefined, redirect: "manual" });
    return { status: res.status, headers: Object.fromEntries(res.headers.entries()), body: Buffer.from(await res.arrayBuffer()), cut: false };
  };
}

// A field's value as it goes into an address: plain, so it can't add a
// path, a host, a port or a query of its own.
const PLAIN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function fill(template: string, fields: Record<string, string>): string {
  return template.replace(/\{([a-z]+)\}/g, (_, key: string) => {
    const v = (fields[key] ?? "").trim();
    if (!PLAIN.test(v)) throw new ServiceRefused(`The connection's ${key} isn't a plain name, so nothing was sent.`);
    return v;
  });
}

// A Custom API is the owner's own address and header: its base, host and
// where its key goes come from what they gave when connecting it.
function resolved(entry: ServiceEntry, fields: Record<string, string>): ServiceEntry {
  if (entry.id !== "custom") return entry;
  let host = "";
  try {
    const u = new URL((fields.base ?? "").trim());
    if (u.protocol === "https:" && !u.username && !u.password) host = u.host;
  } catch {
    // No host: nothing can be reached.
  }
  const header = (fields.header ?? "").trim().toLowerCase() || "authorization";
  if (!/^[a-z0-9-]{1,60}$/.test(header)) throw new ServiceRefused("The connection's header isn't a header's name.");
  const prefix = (fields.prefix ?? "").trim();
  return { ...entry, base: (fields.base ?? "").trim(), hosts: host ? [host] : [], place: { in: "header", name: header, prefix: prefix ? `${prefix} ` : header === "authorization" ? "Bearer " : "" } };
}

// The hosts a call through this connection may reach. "*" is any public
// host (a feed's).
export function hostsOf(entry: ServiceEntry, fields: Record<string, string>): string[] {
  if (entry.auth === "webhook_url") {
    try {
      return [new URL(fields.url ?? "").host];
    } catch {
      return [];
    }
  }
  const e = resolved(entry, fields);
  if (entry.id === "custom") return e.hosts;
  return e.hosts.map((h) => (h === "*" ? h : fill(h, fields)).toLowerCase());
}

const hostAllowed = (host: string, hosts: string[]) => hosts.includes("*") || hosts.includes(host.toLowerCase());

// The values that must never come back: every secret field's, and for a
// webhook its whole address.
export function secretValues(entry: ServiceEntry, fields: Record<string, string>): string[] {
  const out = entry.fields.filter((f) => f.secret).map((f) => fields[f.key] ?? "");
  if (entry.auth === "webhook_url") {
    try {
      const u = new URL(fields.url ?? "");
      out.push(...u.pathname.split("/").filter((p) => p.length >= 16));
    } catch {
      // Nothing more to hide.
    }
  }
  return out.map((v) => v.trim()).filter((v) => v.length >= 6);
}

export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join("[secret]");
  return out;
}

function redactDeep(value: unknown, secrets: string[]): unknown {
  if (!secrets.length) return value;
  return JSON.parse(redact(JSON.stringify(value) ?? "null", secrets));
}

// The request for one call: its address, method, headers and body, with
// the secret where the catalog says it goes.
export function buildRequest(given: ServiceEntry, fields: Record<string, string>, call: ServiceCall): { url: URL; method: Method; headers: Record<string, string>; body: string | null } {
  const entry = resolved(given, fields);
  if (!(METHODS as readonly string[]).includes(call.method)) throw new ServiceRefused(`${call.method} isn't a method a connection takes.`);
  let url: URL;
  if (call.url) {
    if (!entry.hosts.includes("*")) throw new ServiceRefused(`${entry.name} is reached by a path under its own address, never a whole address.`);
    try {
      url = new URL(call.url);
    } catch {
      throw new ServiceRefused("That isn't a web address.");
    }
  } else {
    const path = call.path ?? "";
    if (path && (!path.startsWith("/") || path.startsWith("//") || /:\/\/|\\/.test(path))) throw new ServiceRefused(`A path starts with "/" and stays under ${entry.name}'s own address.`);
    if (path.split(/[/?#]/).some((part) => part === ".." || part === ".")) throw new ServiceRefused("A path can't go up a level.");
    const base = entry.auth === "webhook_url" || entry.id === "custom" ? entry.auth === "webhook_url" ? (fields.url ?? "").trim() : entry.base : fill(entry.base, fields);
    try {
      url = new URL(`${base.replace(/\/+$/, "")}${path}`);
    } catch {
      throw new ServiceRefused("The connection's address isn't a web address.");
    }
  }
  if (url.username || url.password) throw new ServiceRefused("Addresses with a name or password in them can't be reached.");
  if (url.protocol !== "https:" && !entry.hosts.includes("*")) throw new ServiceRefused("Services are reached over https only.");
  const hosts = hostsOf(given, fields);
  if (!hostAllowed(url.host, hosts)) throw new ServiceRefused(`${url.host} isn't one of ${entry.name}'s addresses, so nothing was sent.`);
  for (const [k, v] of Object.entries(call.query ?? {})) url.searchParams.set(k, String(v));
  const headers: Record<string, string> = { accept: "application/json", ...(entry.headers ?? {}) };
  const place = entry.place;
  const secret = entry.keyField ?? entry.fields.find((f) => f.secret)?.key;
  const key = secret ? (fields[secret] ?? "").trim() : "";
  if (place && key) {
    if (place.in === "header") headers[place.name] = `${place.prefix ?? ""}${key}`;
    else if (place.in === "query") url.searchParams.set(place.name, key);
    else if (place.in === "basic") {
      const user = (fields[place.user] ?? "").trim();
      if (!user || /[:\s]/.test(user)) throw new ServiceRefused(`The connection's ${place.user} isn't filled in, so nothing was sent.`);
      headers.authorization = `Basic ${Buffer.from(`${user}:${key}`).toString("base64")}`;
    }
  }
  let body: string | null = null;
  if (call.body !== undefined && call.body !== null && call.method !== "GET") {
    if (call.form) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries((call.body ?? {}) as Record<string, unknown>)) if (v !== undefined && v !== null) params.set(k, String(v));
      body = params.toString();
      headers["content-type"] = "application/x-www-form-urlencoded";
    } else {
      body = JSON.stringify(call.body);
      headers["content-type"] = "application/json";
    }
  }
  return { url, method: call.method, headers, body };
}

// What came back, as data: JSON parsed, a page as its readable text,
// anything else as text, within a size.
function readAnswer(a: Answered): unknown {
  const type = (a.headers["content-type"] ?? "").toLowerCase();
  const text = a.body.toString("utf8");
  if (/json/.test(type) || /^\s*[[{]/.test(text)) {
    try {
      return JSON.parse(text);
    } catch {
      // Not JSON after all: its text.
    }
  }
  const plain = /html/.test(type) ? pageText(text) : text.trim();
  return plain.length > MAX_ANSWER_TEXT ? `${plain.slice(0, MAX_ANSWER_TEXT)}\n[The answer was longer: only its start is here.]` : plain;
}

// Short-lived tokens a key was exchanged for (catalog exchange), by the
// service's host and app, kept in this process until a minute before they
// run out. Never stored, never handed back.
const exchanged = new Map<string, { token: string; until: number }>();

export function forgetExchanged(): void {
  exchanged.clear();
}

async function exchangeToken(entry: ServiceEntry, fields: Record<string, string>, transport: Transport, now: number): Promise<string> {
  const ex = entry.exchange!;
  const host = hostsOf(entry, fields)[0];
  if (!host) throw new ServiceRefused(`The connection's ${entry.name} address isn't one.`);
  const fill = (v: string) => v.replace(/\{([a-z_]+)\}/g, (_, k: string) => (fields[k] ?? "").trim());
  const key = `${entry.id}|${host}|${fill("{client_id}")}|${createHash("sha256").update(fields[ex.when] ?? "").digest("hex").slice(0, 16)}`;
  const kept = exchanged.get(key);
  if (kept && kept.until > now + 60_000) return kept.token;
  const body = new URLSearchParams(Object.fromEntries(Object.entries(ex.body).map(([k, v]) => [k, fill(v)]))).toString();
  const answered = await transport(`https://${host}${ex.path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body });
  if (answered.status < 200 || answered.status >= 300) throw new ServiceRefused(`${entry.name} turned down the app's client ID and secret (it answered ${answered.status}): check them, and that the app is installed on the store.`);
  let token = "";
  let expires = 3600;
  try {
    const data = JSON.parse(answered.body.toString("utf8")) as Record<string, unknown>;
    token = typeof data[ex.token] === "string" ? (data[ex.token] as string) : "";
    expires = Number(data[ex.expires]) > 0 ? Number(data[ex.expires]) : expires;
  } catch {
    // No token in it: said below.
  }
  if (!token) throw new ServiceRefused(`${entry.name} gave no token for the app's client ID and secret.`);
  exchanged.set(key, { token, until: now + expires * 1000 });
  return token;
}

// One call, its redirects followed only within the connection's own hosts.
export async function callService(entry: ServiceEntry, given: Record<string, string>, call: ServiceCall, transport: Transport, now = Date.now()): Promise<ServiceAnswer> {
  let fields = given;
  if (entry.exchange && entry.keyField && !given[entry.keyField] && given[entry.exchange.when]) {
    try {
      fields = { ...given, [entry.keyField]: await exchangeToken(entry, given, transport, now) };
    } catch (err) {
      const secrets = secretValues(entry, given);
      if (err instanceof ServiceRefused) throw new ServiceRefused(redact(err.message, secrets));
      if (err instanceof WebRefused) throw new ServiceRefused(redact(err.message, secrets));
      throw new ServiceUnreachable(`${entry.name} couldn't be reached just now.`);
    }
  }
  const secrets = secretValues(entry, fields);
  const req = buildRequest(entry, fields, call);
  const hosts = hostsOf(entry, fields);
  let url = req.url;
  let method: string = req.method;
  let body = req.body;
  try {
    for (let hops = 0; ; hops++) {
      const answered = await transport(url.toString(), { method, headers: req.headers, body });
      const location = answered.headers.location;
      if (answered.status >= 300 && answered.status < 400 && location) {
        if (hops >= MAX_REDIRECTS) throw new ServiceRefused(`${entry.name} sent it on more than ${MAX_REDIRECTS} times.`);
        const next = new URL(location, url);
        if (!hostAllowed(next.host, hosts) || (next.protocol !== "https:" && !hosts.includes("*"))) throw new ServiceRefused(`${entry.name} sent it on to ${next.host}, which this connection doesn't reach, so it stopped there.`);
        // A 303 (and a 301 or 302 for anything but a GET, as browsers do)
        // goes on as a GET with no body.
        if (answered.status === 303 || ((answered.status === 301 || answered.status === 302) && method !== "GET")) {
          method = "GET";
          body = null;
        }
        url = next;
        continue;
      }
      const rate = rateOf(answered.headers);
      return { status: answered.status, data: redactDeep(readAnswer(answered), secrets), ...(rate ? { rate } : {}) };
    }
  } catch (err) {
    if (err instanceof ServiceRefused) throw new ServiceRefused(redact(err.message, secrets));
    if (err instanceof WebRefused) throw new ServiceRefused(redact(err.message, secrets));
    if (err instanceof WebUnreachable) throw new ServiceUnreachable(`${entry.name} couldn't be reached: ${redact(err.message, secrets).replace(/^The /, "the ")}`);
    throw new ServiceUnreachable(`${entry.name} couldn't be reached just now.`);
  }
}

// A value at a path in an answer ("data.viewer.name"), as text.
export function pick(data: unknown, path: string): string | null {
  let at: unknown = data;
  for (const key of path.split(".")) {
    if (at === null || typeof at !== "object") return null;
    at = (at as Record<string, unknown>)[key];
  }
  return typeof at === "string" || typeof at === "number" ? String(at).trim().slice(0, 80) || null : null;
}
