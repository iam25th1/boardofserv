import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { decryptSecret, encryptSecret, lookupHash } from "../crypto";
import { agentInstallations, agentVersions, connections, type ConnectionProvider } from "../db/schema";
import type { ConnectionDTO } from "../types";
import { connectionsNeeded, type AgentDefinition } from "../agents/definition";
import type { Runtime } from "../agents/runtime/context";

// The connection vault: what each owner has linked (their Telegram chat,
// their Google account, their Typeform personal token), one connection per
// service. The secret is kept
// encrypted (crypto.ts) and decrypted here only, on the server, for the one
// call that needs it. Nothing in here ever hands a secret to agent code, a
// maker, a log line or a response: a connection is described to its owner
// by its label and dates alone. Disconnecting revokes the access where the
// service allows it, forgets the secret, and pauses every installation of
// the owner's that needs it, saying why.

export interface TelegramSecret {
  chatId: number;
  userId: number;
}

export interface GoogleSecret {
  refreshToken: string;
  accessToken: string | null;
  // When the access token stops working (ms since the epoch).
  expiresAt: number | null;
  scope: string;
}

// A Typeform personal token the owner pasted: read access to their forms
// and responses, never shown again.
export interface TypeformSecret {
  token: string;
}

export type SecretOf<P extends ConnectionProvider> = P extends "telegram" ? TelegramSecret : P extends "google" ? GoogleSecret : TypeformSecret;

export const SERVICE_NAME: Record<ConnectionProvider, string> = { telegram: "Telegram", google: "Google", typeform: "Typeform" };

// A Telegram chat's lookup key: its owner can be found without decrypting
// every connection, and the chat id isn't readable from the database.
export const chatLookup = (chatId: number) => lookupHash("telegram-chat", String(chatId));

export async function keep<P extends ConnectionProvider>(rt: Runtime, ownerUserId: string, provider: P, label: string, secret: SecretOf<P>): Promise<void> {
  const now = rt.now();
  const lookup = provider === "telegram" ? chatLookup((secret as TelegramSecret).chatId) : null;
  const values = { label: label.slice(0, 120), secretEncrypted: encryptSecret(JSON.stringify(secret)), lookup, updatedAt: now };
  await rt.db
    .insert(connections)
    .values({ ownerUserId, provider, ...values, createdAt: now })
    .onConflictDoUpdate({ target: [connections.ownerUserId, connections.provider], set: values });
}

// The owner's secret for a service, decrypted, or null when they haven't
// connected it. A secret that can't be decrypted (the key changed) counts
// as not connected.
export async function secretOf<P extends ConnectionProvider>(rt: Runtime, ownerUserId: string, provider: P): Promise<SecretOf<P> | null> {
  const [row] = await rt.db
    .select({ secret: connections.secretEncrypted })
    .from(connections)
    .where(and(eq(connections.ownerUserId, ownerUserId), eq(connections.provider, provider)));
  if (!row) return null;
  try {
    return JSON.parse(decryptSecret(row.secret)) as SecretOf<P>;
  } catch {
    rt.log(`vault: a stored ${provider} connection could not be decrypted; it counts as not connected`);
    return null;
  }
}

// A new secret for a connection that is still there (a refreshed token).
export async function replaceSecret<P extends ConnectionProvider>(rt: Runtime, ownerUserId: string, provider: P, secret: SecretOf<P>): Promise<void> {
  const now = rt.now();
  await rt.db
    .update(connections)
    .set({ secretEncrypted: encryptSecret(JSON.stringify(secret)), updatedAt: now, lastUsedAt: now })
    .where(and(eq(connections.ownerUserId, ownerUserId), eq(connections.provider, provider)));
}

export async function touch(rt: Runtime, ownerUserId: string, provider: ConnectionProvider): Promise<void> {
  await rt.db
    .update(connections)
    .set({ lastUsedAt: rt.now() })
    .where(and(eq(connections.ownerUserId, ownerUserId), eq(connections.provider, provider)));
}

// Whose Telegram chat this is, or null.
export async function ownerOfChat(rt: Runtime, chatId: number): Promise<string | null> {
  const [row] = await rt.db
    .select({ owner: connections.ownerUserId })
    .from(connections)
    .where(and(eq(connections.provider, "telegram"), eq(connections.lookup, chatLookup(chatId))));
  return row?.owner ?? null;
}

export async function hasConnection(rt: Runtime, ownerUserId: string, provider: ConnectionProvider): Promise<boolean> {
  const [row] = await rt.db
    .select({ id: connections.id })
    .from(connections)
    .where(and(eq(connections.ownerUserId, ownerUserId), eq(connections.provider, provider)));
  return Boolean(row);
}

// The owner's installations that are running (or being set up) and need
// this service.
async function installationsNeeding(rt: Runtime, ownerUserId: string, provider: ConnectionProvider) {
  const rows = await rt.db
    .select({ id: agentInstallations.id, status: agentInstallations.status, definition: agentVersions.definition })
    .from(agentInstallations)
    .innerJoin(agentVersions, eq(agentVersions.id, agentInstallations.versionId))
    .where(and(eq(agentInstallations.ownerUserId, ownerUserId), inArray(agentInstallations.status, ["active", "paused"])));
  return rows.filter((r) => r.definition && connectionsNeeded(r.definition as AgentDefinition)[provider]);
}

export const DISCONNECTED: Record<ConnectionProvider, string> = {
  telegram: "Telegram was disconnected, and this agent messages you there. Link Telegram again on Connections, then resume it.",
  google: "Google was disconnected, and this agent works on your sheets. Connect Google again on Connections, then resume it.",
  typeform: "Typeform was disconnected, and this agent reads your form's answers. Connect Typeform again on Connections, then resume it.",
};

// Pauses every running installation of the owner's that needs this
// service, with the reason. Returns how many.
export async function pauseNeeding(rt: Runtime, ownerUserId: string, provider: ConnectionProvider, reason: string): Promise<number> {
  const ids = (await installationsNeeding(rt, ownerUserId, provider)).filter((r) => r.status === "active").map((r) => r.id);
  if (!ids.length) return 0;
  await rt.db
    .update(agentInstallations)
    .set({ status: "paused", pausedReason: reason, updatedAt: rt.now() })
    .where(and(inArray(agentInstallations.id, ids), eq(agentInstallations.status, "active")));
  return ids.length;
}

// Revoking at the service, where it allows it. True when it was revoked,
// false when it refused or couldn't be reached, null when it has no way to.
async function revoke(rt: Runtime, provider: ConnectionProvider, secret: SecretOf<ConnectionProvider> | null): Promise<boolean | null> {
  if (provider !== "google" || !secret) return null;
  const token = (secret as GoogleSecret).refreshToken;
  try {
    const res = await rt.services.fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface Disconnected {
  revoked: boolean | null;
  paused: number;
}

// The owner disconnects a service: revoked where it can be, forgotten, and
// what needs it paused. Null when it wasn't connected.
export async function disconnect(rt: Runtime, ownerUserId: string, provider: ConnectionProvider, farewell?: (secret: SecretOf<ConnectionProvider>) => Promise<void>): Promise<Disconnected | null> {
  if (!(await hasConnection(rt, ownerUserId, provider))) return null;
  const secret = await secretOf(rt, ownerUserId, provider);
  const revoked = await revoke(rt, provider, secret);
  if (secret && farewell) await farewell(secret).catch(() => undefined);
  await rt.db.delete(connections).where(and(eq(connections.ownerUserId, ownerUserId), eq(connections.provider, provider)));
  const paused = await pauseNeeding(rt, ownerUserId, provider, DISCONNECTED[provider]);
  rt.log(`vault: an owner disconnected ${SERVICE_NAME[provider]}${revoked === false ? " (revoking it at the service failed)" : ""}; ${paused} paused`);
  return { revoked, paused };
}

// What the owner sees of their connections: never the secret.
export async function connectionsOf(rt: Runtime, ownerUserId: string): Promise<ConnectionDTO[]> {
  const rows = await rt.db
    .select({ provider: connections.provider, label: connections.label, createdAt: connections.createdAt, lastUsedAt: connections.lastUsedAt })
    .from(connections)
    .where(eq(connections.ownerUserId, ownerUserId));
  return Promise.all(
    rows.map(async (r) => ({
      provider: r.provider,
      name: SERVICE_NAME[r.provider],
      label: r.label,
      connectedAt: r.createdAt.toISOString(),
      lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
      usedBy: (await installationsNeeding(rt, ownerUserId, r.provider)).map((i) => ({ id: i.id, name: (i.definition as AgentDefinition).name, status: i.status })),
    })),
  );
}
