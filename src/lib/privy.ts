import "server-only";
import { PrivyClient } from "@privy-io/server-auth";

// Server-side Privy. Verifies the access token the browser holds and, in tests,
// creates and signs with a server wallet (the method FINDINGS.md proved works).
// The app secret lives only here, on the server.

let client: PrivyClient | null = null;

export function privy(): PrivyClient {
  if (client) return client;
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  const secret = process.env.PRIVY_APP_SECRET;
  if (!appId || !secret) throw new Error("Privy app id and secret must be set");
  client = new PrivyClient(appId, secret);
  return client;
}

export interface PrivyIdentity {
  userId: string;
  email: string | null;
}

// Verify the Privy access token and return the user's id and email. Throws if
// the token is missing or invalid.
export async function verifyPrivyToken(token: string): Promise<PrivyIdentity> {
  const claims = await privy().verifyAuthToken(token);
  const user = await privy().getUser(claims.userId);
  const email = user.email?.address ?? user.google?.email ?? null;
  return { userId: claims.userId, email };
}