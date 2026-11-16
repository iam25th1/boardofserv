import "server-only";
import type { Runtime } from "../agents/runtime/context";
import { transportOf } from "../agents/runtime/context";
import { entryOf, type ServiceEntry } from "./catalog";
import { callService, pick, ServiceRefused, ServiceUnreachable } from "./request";
import { keep } from "./vault";

// Connecting a service with what the owner pastes (a key, a token, a
// webhook's address, with an account or a shop's name where the service
// needs one). Each is checked once, with the service's own cheap call,
// before it is kept: a key that works is kept encrypted and never shown
// again, and the owner is told whose it is ("Connected as X"); one that
// doesn't is refused with a plain reason, and nothing is kept.
// A new connection only reads: writing through it is the owner's switch.

export class ConnectRefused extends Error {
  constructor(
    message: string,
    // 400: what was pasted; 503: the service couldn't be reached.
    readonly status: 400 | 503,
  ) {
    super(message);
    this.name = "ConnectRefused";
  }
}

// What a key is called in a sentence ("That token didn't work").
const nounOf = (e: ServiceEntry) => (e.fields.find((f) => f.secret)?.label ?? "key").trim().split(/\s+/).at(-1)!.toLowerCase();

// The fields as the owner gave them: every one the service needs, each as
// it should look. Only the catalog's fields are kept.
export function readFields(e: ServiceEntry, given: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of e.fields) {
    const raw = given[f.key];
    const v = typeof raw === "string" ? raw.trim() : "";
    if (!v) {
      if (f.optional) continue;
      throw new ConnectRefused(`Paste your ${e.short ?? e.name} ${f.label.toLowerCase()}.`, 400);
    }
    if (v.length > 2000) throw new ConnectRefused(`That ${f.label.toLowerCase()} is too long to be one.`, 400);
    if (f.choices && !f.choices.includes(v)) throw new ConnectRefused(`Pick one of: ${f.choices.join(", ")}.`, 400);
    if (f.pattern && !new RegExp(f.pattern).test(v)) throw new ConnectRefused(f.patternWhy ?? `That doesn't look like a ${e.short ?? e.name} ${f.label.toLowerCase()}.`, 400);
    out[f.key] = v;
  }
  return out;
}

const hostOf = (base: string | undefined) => {
  try {
    return new URL(base ?? "").host;
  } catch {
    return "your API";
  }
};

// The check: who the key belongs to, or why it doesn't work.
export async function checkKey(rt: Runtime, e: ServiceEntry, fields: Record<string, string>): Promise<string> {
  const name = e.short ?? e.name;
  // A Custom API is checked at the path its owner gave, if they gave one.
  const check = e.id === "custom" ? (fields.check ? { method: "GET" as const, path: fields.check.startsWith("/") ? fields.check : `/${fields.check}`, text: hostOf(fields.base) } : null) : e.check;
  if (!check) return e.id === "custom" ? `${name} (${hostOf(fields.base)})` : name;
  let got: { status: number; data: unknown };
  try {
    got = await callService(e, fields, { method: check.method, path: check.path, query: check.query, body: check.body }, transportOf(rt));
  } catch (err) {
    if (err instanceof ServiceRefused) throw new ConnectRefused(`${err.message} Check what you pasted.`, 400);
    if (err instanceof ServiceUnreachable) throw new ConnectRefused(`${name} couldn't be reached just now. Try again in a minute.`, 503);
    throw err;
  }
  const body = JSON.stringify(got.data ?? "");
  const accepted = check.accept?.find((a) => a.status === got.status && body.includes(a.match));
  if (accepted) return `${name} (${accepted.text})`;
  const turnedDown = `That ${nounOf(e)} didn't work with ${name}: check ${e.turnedDown ?? "it's the whole of it, or make a new one"}.`;
  if (got.status === 401 || got.status === 403 || got.status === 404 || got.status === 400) throw new ConnectRefused(turnedDown, 400);
  if (got.status === 429) throw new ConnectRefused(`${name} is busy just now. Try again in a minute.`, 503);
  if (got.status < 200 || got.status >= 300) throw new ConnectRefused(`${name} couldn't check it just now (it answered ${got.status}). Try again in a minute.`, 503);
  if (check.failsWhen && body.includes(check.failsWhen)) throw new ConnectRefused(turnedDown, 400);
  const who = check.label ? pick(got.data, check.label) : null;
  return `${name} (${who ?? check.text ?? "connected"})`;
}

// Connect a service: checked, then kept. Returns what the owner sees.
export async function connectService(rt: Runtime, ownerUserId: string, id: string, given: Record<string, unknown>): Promise<{ label: string }> {
  const e = entryOf(id);
  if (!e || !["api_key", "bearer", "bot_token", "webhook_url"].includes(e.auth)) throw new ConnectRefused("That service isn't connected with a key here.", 400);
  const fields = readFields(e, given);
  const label = await checkKey(rt, e, fields);
  await keep(rt, ownerUserId, e.id, label, fields);
  rt.log(`connections: an owner connected ${e.name}`);
  return { label };
}
