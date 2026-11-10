import "server-only";
import { NotFoundError, PrivyClient, type User } from "@privy-io/node";

// Server-side Privy. Verifies the access token the browser holds and, in tests,
// creates and signs with a server wallet (the method FINDINGS.md proved works).
// The app secret lives only here, on the server. @privy-io/node replaced
// @privy-io/server-auth (deprecated): the same calls, with snake_case fields.

let client: PrivyClient | null = null;

export function privy(): PrivyClient {
  if (client) return client;
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  const secret = process.env.PRIVY_APP_SECRET;
  if (!appId || !secret) throw new Error("Privy app id and secret must be set");
  client = new PrivyClient({ appId, appSecret: secret });
  return client;
}

export interface PrivyIdentity {
  userId: string;
  email: string | null;
  // The Ethereum wallets linked to the user: the embedded one and any
  // external wallet they linked by signing with it.
  wallets?: { address: string; embedded: boolean }[];
}

// Verify the Privy access token and return the user's id, email and linked
// wallets. Throws if the token is missing or invalid.
export async function verifyPrivyToken(token: string): Promise<PrivyIdentity> {
  const claims = await privy().utils().auth().verifyAccessToken(token);
  const user = await privy().users()._get(claims.user_id);
  const email = emailOf(user);
  const wallets = user.linked_accounts.flatMap((a) =>
    a.type === "wallet" && a.chain_type === "ethereum" ? [{ address: a.address, embedded: a.wallet_client_type === "privy" }] : [],
  );
  return { userId: claims.user_id, email, wallets };
}

// The email they signed in with, or their Google account's.
function emailOf(user: User): string | null {
  for (const a of user.linked_accounts) if (a.type === "email") return a.address;
  for (const a of user.linked_accounts) if (a.type === "google_oauth") return a.email;
  return null;
}

// The Privy user an Ethereum wallet (embedded, or external and linked with a
// signature) belongs to, or null. Throws when Privy can't be asked.
export async function privyWalletOwner(address: string): Promise<string | null> {
  let user: User;
  try {
    user = await privy().users().getByWalletAddress({ address });
  } catch (err) {
    // No user has it (server-auth answered null; @privy-io/node throws).
    if (err instanceof NotFoundError) return null;
    throw err;
  }
  const linked = user.linked_accounts.some((a) => a.type === "wallet" && a.chain_type === "ethereum" && a.address.toLowerCase() === address.toLowerCase());
  return linked ? user.id : null;
}
