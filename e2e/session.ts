import type { BrowserContext, Page } from "@playwright/test";

// A signed-in session without Privy: the Privy SDK in the page runs for real,
// but every call it makes to auth.privy.io is answered here, and the app's
// own /api calls that need a verified account are answered with canned data.
// Nothing leaves the machine. The app id is a made-up one of the right length
// (privy-config.ts mounts Privy only for a 25 character id), set for the dev
// server in playwright.config.ts.

export const E2E_PRIVY_APP_ID = "e2etestappid0000000000000";

// The app config Privy reads on start, in the shape auth.privy.io sends it:
// email sign-in and an embedded Ethereum wallet, nothing else.
const APP_CONFIG = { id: E2E_PRIVY_APP_ID, ...{"name":"boardofserv","legal_name":null,"logo_url":null,"icon_url":null,"terms_and_conditions_url":null,"privacy_policy_url":null,"require_users_accept_terms":null,"theme":"System","accent_color":null,"show_wallet_login_first":false,"allowed_domains":[],"allowed_native_app_ids":[],"allowed_native_app_url_schemes":[],"wallet_auth":true,"email_auth":true,"sms_auth":false,"guest_auth":false,"solana_wallet_auth":true,"external_wallets_for_signup_enabled":true,"telegram_auth":false,"telegram_seamless_auth_enabled":false,"disable_plus_emails":false,"merge_accounts_by_email":true,"google_oauth":false,"twitter_oauth":false,"discord_oauth":false,"github_oauth":false,"tiktok_oauth":false,"line_oauth":false,"twitch_oauth":false,"linkedin_oauth":false,"apple_oauth":false,"spotify_oauth":false,"instagram_oauth":false,"telegram_oauth":false,"farcaster_auth":false,"passkey_auth":false,"passkeys_for_signup_enabled":false,"custom_jwt_auth":false,"allowlist_enabled":false,"allowlist_config":{"error_title":null,"error_detail":null,"cta_text":null,"cta_link":null},"custom_oauth_providers":[],"wallet_connect_cloud_project_id":"","custom_api_url":null,"embedded_wallet_config":{"create_on_login":"users-without-wallets","ethereum":{"create_on_login":"users-without-wallets"},"solana":{"create_on_login":"users-without-wallets"},"user_owned_recovery_options":["user-passcode"],"require_user_password_on_create":false,"require_user_owned_recovery_on_create":false,"mode":"user-controlled-server-wallets-only"},"enforce_wallet_uis":true,"legacy_wallet_ui_config":false,"fiat_on_ramp_enabled":false,"captcha_enabled":false,"enabled_captcha_provider":null,"twitter_oauth_on_mobile_enabled":true,"mfa_methods":[],"verification_key":"","max_linked_wallets_per_user":20,"farcaster_link_wallets_enabled":false,"whatsapp_enabled":false,"smart_wallet_config":{"enabled":false},"data_classification":"public"} };

export const ACCOUNT = {
  email: "maya@example.com",
  handle: "maker_4821",
  handleChosen: false,
  walletAddress: "0x5f88a9c1d2e3f4a5b6c7d8e9f0a1b2c3d4e53148",
  openservUserId: null,
  linked: false,
  balance: "unknown",
  admin: true,
  access: "approved",
  servKey: null,
  chat: null,
  paused: false,
};

const USER_ID = "did:privy:e2etestuser0000000000000";

function b64url(o: unknown): string {
  return Buffer.from(JSON.stringify(o)).toString("base64url");
}

// Privy decodes its access token in the browser but never checks the
// signature there, so an unsigned token that expires in an hour will do.
function token(): string {
  const now = Math.floor(Date.now() / 1000);
  return [b64url({ alg: "ES256", typ: "JWT" }), b64url({ sid: "e2e-session", iss: "privy.io", iat: now, aud: E2E_PRIVY_APP_ID, sub: USER_ID, exp: now + 3600 }), "e2e"].join(".");
}

function privyUser() {
  const at = Math.floor(Date.now() / 1000);
  return {
    id: USER_ID,
    created_at: at,
    has_accepted_terms: true,
    is_guest: false,
    mfa_methods: [],
    linked_accounts: [
      { type: "email", address: ACCOUNT.email, verified_at: at, first_verified_at: at, latest_verified_at: at },
      {
        type: "wallet",
        address: ACCOUNT.walletAddress,
        chain_type: "ethereum",
        chain_id: "eip155:84532",
        wallet_client: "privy",
        wallet_client_type: "privy",
        connector_type: "embedded",
        imported: false,
        delegated: false,
        wallet_index: 0,
        recovery_method: "privy",
        verified_at: at,
        first_verified_at: at,
        latest_verified_at: at,
      },
    ],
  };
}

// Signs the context in: Privy's stored tokens before any page loads, and
// its server answered from here.
export async function signIn(context: BrowserContext): Promise<void> {
  const access = token();
  await context.addInitScript(
    ([access, refresh]) => {
      // Privy keeps its own token (pat), the app's token and the refresh
      // token, each as JSON. With all three it restores the session on load.
      localStorage.setItem("privy:pat", JSON.stringify(access));
      localStorage.setItem("privy:token", JSON.stringify(access));
      localStorage.setItem("privy:refresh_token", JSON.stringify(refresh));
    },
    [access, "e2e-refresh-token"],
  );
  await context.route(/^https:\/\/([a-z0-9-]+\.)?privy\.io\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === `/api/v1/apps/${E2E_PRIVY_APP_ID}`) return route.fulfill({ json: APP_CONFIG });
    if (url.pathname === "/api/v1/sessions") {
      return route.fulfill({ json: { user: privyUser(), token: token(), refresh_token: "e2e-refresh-token", identity_token: null, session_update_action: "set" } });
    }
    if (url.pathname === "/api/v1/sessions/logout") return route.fulfill({ json: {} });
    // The embedded wallet's frame: an empty page is enough for these tests.
    if (route.request().resourceType() === "document") return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>wallet</title>" });
    return route.fulfill({ json: {} });
  });
  await context.route("**/api/account", (route) => (route.request().method() === "GET" ? route.fulfill({ json: ACCOUNT }) : route.fallback()));
}

// Two conversations for the chat's agents popover, one with an agent sketch.
export const CONVERSATIONS = [
  { id: "c1", title: "Tell my Telegram group when ETH drops", sketchName: "ETH floor watch", publishedSlug: null },
  { id: "c2", title: "Daily Gmail summary", sketchName: null, publishedSlug: null },
].map((c) => ({ ...c, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));

export async function withConversations(context: BrowserContext): Promise<void> {
  await context.route("**/api/conversations", (route) => (route.request().method() === "GET" ? route.fulfill({ json: { conversations: CONVERSATIONS } }) : route.fallback()));
}

// The page has loaded and Privy has signed the account in: the account
// button is in the top bar.
export async function signedIn(page: Page): Promise<void> {
  await page.getByRole("button", { name: /^Account, @maker_4821/ }).waitFor();
}
