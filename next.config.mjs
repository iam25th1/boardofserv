// Security headers on every response. The content security policy follows
// Privy's guidance (docs.privy.io/security/implementation-guide/content-security-policy):
// its iframe and API, WalletConnect and Coinbase Wallet for linking an
// external wallet, and Cloudflare Turnstile for its captcha. Next's own
// inline scripts need 'unsafe-inline'. The full policy applies to the
// production build; the development server (which needs eval for fast
// refresh) only refuses to be framed.
const PRIVY_FRAMES = ["https://auth.privy.io", "https://verify.walletconnect.com", "https://verify.walletconnect.org"];

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  `child-src ${PRIVY_FRAMES.join(" ")}`,
  `frame-src ${PRIVY_FRAMES.join(" ")} https://challenges.cloudflare.com`,
  "connect-src 'self' https://auth.privy.io wss://relay.walletconnect.com wss://relay.walletconnect.org wss://www.walletlink.org https://*.rpc.privy.systems https://explorer-api.walletconnect.com",
  "worker-src 'self'",
  "manifest-src 'self'",
].join("; ");

export const SECURITY_HEADERS = (production) => [
  { key: "Content-Security-Policy", value: production ? CSP : "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Never expose server-only secrets to the client. Only NEXT_PUBLIC_* reach
  // the browser bundle, and those are enumerated in .env.example.
  poweredByHeader: false,
  experimental: {
    serverComponentsExternalPackages: ["pg"],
    // src/instrumentation.ts: payments boot when the server starts.
    instrumentationHook: true,
  },
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS(process.env.NODE_ENV === "production") }];
  },
};

export default nextConfig;
