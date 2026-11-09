import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { connections, googleOAuthStates } from "../db/schema";
import type { Runtime, Services } from "../agents/runtime/context";
import { keep, pauseNeeding, replaceSecret, secretOf, type GoogleSecret } from "../connections/vault";

// Google sign-in for a web server app (developers.google.com/identity/
// protocols/oauth2/web-server), once per owner, for their sheets.
//
// Scope: spreadsheets, to read and write a sheet the owner pastes a link
// to. drive.file wouldn't reach it: it covers only files the app made or
// the owner opened with a picker. spreadsheets is a sensitive scope, so
// until the app is verified Google shows an "unverified app" warning, and
// while the app is in Testing mode only its listed test users (up to 100)
// can connect, and their access lasts seven days. openid and email give
// the account's address, the label the owner sees.
//
// access_type=offline with prompt=consent returns a refresh token every
// time, kept in the vault; access tokens (an hour each) are refreshed from
// it when needed. A refresh Google answers with invalid_grant means the
// access was revoked or ran out: the connection is forgotten and what
// needs it pauses, saying why.
//
// The flow is tied to the browser that started it: the state goes to
// Google and into a cookie, and the callback takes only a state that
// matches the cookie, is unused, and is under ten minutes old.

export const SCOPES = ["openid", "email", "https://www.googleapis.com/auth/spreadsheets"];
export const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
export const STATE_COOKIE = "bos_google_state";
export const STATE_MINUTES = 10;

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

export class GoogleRevoked extends Error {
  constructor() {
    super("Google no longer lets boardofserv in.");
    this.name = "GoogleRevoked";
  }
}

export class GoogleUnavailable extends Error {
  constructor(message = "Google couldn't be reached just now.") {
    super(message);
    this.name = "GoogleUnavailable";
  }
}

export const REVOKED_REASON =
  "Google stopped letting boardofserv into your sheets: the access was revoked, or it ran out (while the app is in Google's testing mode it lasts 7 days). Connect Google again on Connections, then resume it.";

// Where returning from Google may land: a page of this site only.
export function safeReturn(to: unknown): string {
  return typeof to === "string" && /^\/(?!\/)[\w\-./?=&%]*$/.test(to) && to.length <= 300 ? to : "/connections";
}

// The start: a state kept (as a hash) for the owner, and Google's address.
export async function startGoogle(rt: Runtime, ownerUserId: string, returnTo: string): Promise<{ url: string; state: string }> {
  const google = rt.services.google;
  if (!google) throw new GoogleUnavailable("Google isn't set up here.");
  const state = randomBytes(24).toString("base64url");
  const now = rt.now();
  await rt.db.insert(googleOAuthStates).values({ stateHash: sha256(state), ownerUserId, returnTo: safeReturn(returnTo), expiresAt: new Date(now.getTime() + STATE_MINUTES * 60_000), createdAt: now });
  const q = new URLSearchParams({
    client_id: google.clientId,
    redirect_uri: google.redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return { url: `https://accounts.google.com/o/oauth2/v2/auth?${q}`, state };
}

type TokenAnswer = { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; id_token?: string; error?: string };

async function tokenCall(services: Services, form: Record<string, string>): Promise<{ status: number; body: TokenAnswer }> {
  let res: Response;
  try {
    res = await services.fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new GoogleUnavailable();
  }
  return { status: res.status, body: ((await res.json().catch(() => ({}))) ?? {}) as TokenAnswer };
}

// The account's email, from the ID token Google just handed over directly
// (no signature check needed for a token from Google's own endpoint).
function emailOf(idToken: string | undefined): string | null {
  try {
    const payload = JSON.parse(Buffer.from(idToken!.split(".")[1]!, "base64url").toString("utf8")) as { email?: string };
    return typeof payload.email === "string" ? payload.email.slice(0, 120) : null;
  } catch {
    return null;
  }
}

export class CallbackRefused extends Error {
  constructor(
    message: string,
    readonly returnTo = "/connections",
  ) {
    super(message);
    this.name = "CallbackRefused";
  }
}

// The way back from Google: the state checked against the cookie and the
// database, the code exchanged, the tokens kept. Returns where to go.
export async function finishGoogle(rt: Runtime, o: { state: string | null; cookie: string | null; code: string | null; error: string | null }): Promise<{ ownerUserId: string; returnTo: string }> {
  const google = rt.services.google;
  if (!google) throw new CallbackRefused("Google isn't set up here.");
  if (!o.state || !o.cookie || o.state.length !== o.cookie.length || !timingSafeEqual(Buffer.from(o.state), Buffer.from(o.cookie))) {
    throw new CallbackRefused("That sign-in didn't start in this browser, or took too long. Try Connect Google again.");
  }
  const now = rt.now();
  const [row] = await rt.db
    .update(googleOAuthStates)
    .set({ usedAt: now })
    .where(and(eq(googleOAuthStates.stateHash, sha256(o.state)), isNull(googleOAuthStates.usedAt), gt(googleOAuthStates.expiresAt, now)))
    .returning();
  if (!row) throw new CallbackRefused("That sign-in took too long or was used already. Try Connect Google again.");
  if (o.error || !o.code) throw new CallbackRefused(o.error === "access_denied" ? "You said no at Google, so nothing was connected." : "Google didn't send a code back. Try again.", row.returnTo);
  const { status, body } = await tokenCall(rt.services, { code: o.code, client_id: google.clientId, client_secret: google.clientSecret, redirect_uri: google.redirectUri, grant_type: "authorization_code" });
  if (status !== 200 || !body.access_token) throw new CallbackRefused("Google didn't take that sign-in. Try again.", row.returnTo);
  const scope = body.scope ?? "";
  if (!scope.split(" ").includes(SHEETS_SCOPE)) {
    throw new CallbackRefused("Google didn't give boardofserv your sheets: tick the box for Google Sheets when it asks, then try again.", row.returnTo);
  }
  if (!body.refresh_token) throw new CallbackRefused("Google didn't give lasting access. Try again.", row.returnTo);
  const secret: GoogleSecret = { refreshToken: body.refresh_token, accessToken: body.access_token, expiresAt: now.getTime() + (body.expires_in ?? 3600) * 1000, scope };
  await keep(rt, row.ownerUserId, "google", emailOf(body.id_token) ?? "your Google account", secret);
  return { ownerUserId: row.ownerUserId, returnTo: row.returnTo };
}

// A working access token for the owner, refreshed when it has (nearly)
// run out. Null when they haven't connected Google. A refresh Google
// refuses for good forgets the connection and pauses what needs it.
export async function accessToken(rt: Runtime, ownerUserId: string, force = false): Promise<string | null> {
  const secret = await secretOf(rt, ownerUserId, "google");
  if (!secret) return null;
  if (!force && secret.accessToken && secret.expiresAt && secret.expiresAt - 60_000 > rt.now().getTime()) return secret.accessToken;
  const google = rt.services.google;
  if (!google) throw new GoogleUnavailable("Google isn't set up here.");
  const { status, body } = await tokenCall(rt.services, { client_id: google.clientId, client_secret: google.clientSecret, refresh_token: secret.refreshToken, grant_type: "refresh_token" });
  if (body.error === "invalid_grant" || (status === 400 && body.error === "unauthorized_client")) {
    await revoked(rt, ownerUserId);
    throw new GoogleRevoked();
  }
  if (status !== 200 || !body.access_token) throw new GoogleUnavailable();
  const fresh: GoogleSecret = { ...secret, accessToken: body.access_token, expiresAt: rt.now().getTime() + (body.expires_in ?? 3600) * 1000, ...(body.refresh_token ? { refreshToken: body.refresh_token } : {}) };
  await replaceSecret(rt, ownerUserId, "google", fresh);
  return fresh.accessToken!;
}

// Google said no for good: forget the connection, pause what needs it.
export async function revoked(rt: Runtime, ownerUserId: string): Promise<void> {
  await rt.db.delete(connections).where(and(eq(connections.ownerUserId, ownerUserId), eq(connections.provider, "google")));
  const paused = await pauseNeeding(rt, ownerUserId, "google", REVOKED_REASON);
  rt.log(`google: an owner's access was revoked or ran out; ${paused} paused`);
}
