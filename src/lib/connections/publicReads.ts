import "server-only";
import type { ServiceAnswer } from "./request";

// Reading GitHub without a key: every agent on this server without its
// owner's own GitHub connection shares one allowance of public reads (60 an
// hour, from the server's address). So the same read within ten minutes is
// answered from here, never asked twice; what GitHub says is left of the
// allowance is kept; and when it runs low the owner is told, in plain
// words, to connect GitHub with a free read-only token, which reads with
// their own allowance instead. In this process only: a restart starts
// afresh, and GitHub's own answers keep it right.

export const PUBLIC_CACHE_MS = 10 * 60_000;
// Left of the shared allowance when the owner is told to connect.
export const LOW_PUBLIC_READS = 10;
const MAX_CACHED = 500;

const cache = new Map<string, { at: number; answer: ServiceAnswer }>();
let left: { remaining: number; resetAt: number } | null = null;
// Each installation told once for each time the allowance runs low.
const told = new Map<string, number>();

export function cachedRead(key: string, now: number): ServiceAnswer | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (now - hit.at > PUBLIC_CACHE_MS) {
    cache.delete(key);
    return null;
  }
  return structuredClone(hit.answer);
}

export function keepRead(key: string, answer: ServiceAnswer, now: number): void {
  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: now, answer: structuredClone(answer) });
}

// What GitHub said is left, from a read's answer.
export function noteAllowance(rate: ServiceAnswer["rate"], now: number): void {
  if (!rate) return;
  left = { remaining: rate.remaining, resetAt: rate.reset > 0 ? rate.reset * 1000 : now + 60 * 60_000 };
}

// What is left of the shared allowance, as GitHub last said; null when it
// hasn't said, or the hour it spoke of is over.
export function allowance(now: number): { remaining: number; resetAt: number } | null {
  if (!left || now >= left.resetAt) return null;
  return left;
}

// Whether this installation should be told now: once for each time the
// allowance runs low.
export function shouldTell(installationId: string, resetAt: number): boolean {
  if (told.get(installationId) === resetAt) return false;
  told.set(installationId, resetAt);
  return true;
}

// A public read refused for the shared allowance: GitHub's 403 or 429 with
// nothing left, in its headers or its words.
export function limited(answer: ServiceAnswer): boolean {
  if (answer.status !== 403 && answer.status !== 429) return false;
  return answer.rate?.remaining === 0 || /rate limit/i.test(JSON.stringify(answer.data ?? ""));
}

export function forgetPublicReads(): void {
  cache.clear();
  told.clear();
  left = null;
}
