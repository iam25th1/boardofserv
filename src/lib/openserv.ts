import "server-only";
// Server-side OpenServ client. All calls run on the server; a user's OpenServ
// key never reaches the browser. The SIWE sequence is the one proven in
// ~/openserv-probe/FINDINGS.md: nonce, sign the returned message, verify.

const API = process.env.OPENSERV_API_URL ?? "https://api.openserv.ai";

export interface SiweChallenge {
  message: string;
  nonce: string;
}

// Step 1: ask OpenServ for the message this wallet must sign. The endpoint may
// return a ready message, or only a nonce, in which case we build the EIP-4361
// message ourselves (the form proven in FINDINGS.md).
export async function getSiweChallenge(walletAddress: string): Promise<SiweChallenge> {
  const res = await fetch(`${API}/auth/wallet/nonce`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ walletAddress }),
  });
  if (!res.ok) throw new Error(`nonce failed: ${res.status}`);
  const body = (await res.json()) as { message?: string; nonce?: string };
  if (!body.message && !body.nonce) throw new Error("nonce returned neither a message nor a nonce");
  const message =
    body.message ??
    [
      "platform.openserv.ai wants you to sign in with your Ethereum account:",
      walletAddress,
      "",
      "Sign in to OpenServ",
      "",
      "URI: https://platform.openserv.ai",
      "Version: 1",
      "Chain ID: 1",
      `Nonce: ${body.nonce}`,
      `Issued At: ${new Date().toISOString()}`,
    ].join("\n");
  return { message, nonce: body.nonce ?? "" };
}

export interface SiweResult {
  apiKey: string;
  openservUserId: string;
}

// Step 3: hand the signature back. A wallet OpenServ has not seen creates a new
// account here; a known wallet signs back into the same account.
export async function verifySiwe(walletAddress: string, message: string, signature: string): Promise<SiweResult> {
  const res = await fetch(`${API}/auth/wallet/verify`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ walletAddress, message, signature }),
  });
  if (!res.ok) throw new Error(`verify failed: ${res.status}`);
  const body = (await res.json()) as { apiKey?: string; success?: boolean };
  if (!body.apiKey) throw new Error("verify returned no apiKey");
  const session = await fetch(`${API}/auth/session`, {
    headers: { accept: "application/json", "x-openserv-key": body.apiKey },
  });
  const who = (await session.json()) as { id?: number | string };
  return { apiKey: body.apiKey, openservUserId: who.id !== undefined ? String(who.id) : "" };
}

// OpenServ only reports whether the balance is sufficient, never a number.
export async function balanceSufficient(apiKey: string): Promise<boolean> {
  const res = await fetch(`${API}/wallets/balance/check`, {
    headers: { accept: "application/json", "x-openserv-key": apiKey },
  });
  if (!res.ok) return false;
  const body = (await res.json()) as { hasSufficientBalance?: boolean };
  return body.hasSufficientBalance === true;
}