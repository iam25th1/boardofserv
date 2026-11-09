import "server-only";
import { eq } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "./crypto";
import { db } from "./db";
import { users, type User } from "./db/schema";
import { SERV_BASE_URL, SERV_MODEL } from "./model";

// A user's own SERV key. With one set, their chat and helper uses run on it
// (on their own SERV credit), with no daily message limit and outside the
// site's spend limit. The key is checked with one tiny call before it is
// kept, stored encrypted like the OpenServ keys (crypto.ts), decrypted only
// on the server for a call, and shown only as its last four characters. It
// is never in a response, a log line or an error.

export type KeyCheck = "ok" | "refused" | "no_credit" | "unreachable";

const CHECK_TIMEOUT_MS = 15_000;

// One request of one output token on the key's own credit: SERV answers 200
// for a key it takes, 401 or 403 for one it doesn't, 402 when it has no credit.
export async function checkServKey(key: string, fetchImpl: typeof fetch = fetch): Promise<KeyCheck> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), CHECK_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${SERV_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: SERV_MODEL,
        messages: [
          { role: "system", content: "Reply with one word." },
          { role: "user", content: "Hello" },
        ],
        max_tokens: 1,
        stream: false,
      }),
      signal: ctl.signal,
    });
    if (res.ok) return "ok";
    if (res.status === 401 || res.status === 403) return "refused";
    if (res.status === 402) return "no_credit";
    return "unreachable";
  } catch {
    return "unreachable";
  } finally {
    clearTimeout(timer);
  }
}

export const KEY_CHECK_TEXT: Record<Exclude<KeyCheck, "ok">, string> = {
  refused: "SERV didn't accept that key. Check it and try again.",
  no_credit: "That key has no SERV credit left. Top it up, then add it again.",
  unreachable: "SERV couldn't be reached to check the key. Try again in a few minutes.",
};

// The user's key, decrypted for a call, or null when they have none. A key
// that can't be decrypted (the encryption key changed) counts as none.
export function servKeyOf(user: Pick<User, "servKeyEncrypted">): string | null {
  if (!user.servKeyEncrypted) return null;
  try {
    return decryptSecret(user.servKeyEncrypted);
  } catch {
    console.error("a stored SERV key could not be decrypted; it is ignored until replaced");
    return null;
  }
}

export async function saveServKey(userId: string, key: string): Promise<{ last4: string }> {
  const last4 = key.slice(-4);
  await db.update(users).set({ servKeyEncrypted: encryptSecret(key), servKeyLast4: last4, updatedAt: new Date() }).where(eq(users.id, userId));
  return { last4 };
}

export async function removeServKey(userId: string): Promise<void> {
  await db.update(users).set({ servKeyEncrypted: null, servKeyLast4: null, updatedAt: new Date() }).where(eq(users.id, userId));
}
