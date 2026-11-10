// Security headers on every response. The content security policy follows
// Privy's guidance (docs.privy.io/security/implementation-guide/content-security-policy):
// its iframe and API, Coinbase Wallet, and Cloudflare Turnstile for its
// captcha. Privy bundles WalletConnect's modal (Reown AppKit) for linking an
// external wallet, which loads its config, fonts and wallet logos from
// Reown's own hosts, so those follow Reown's guidance
// (docs.reown.com/advanced/security/content-security-policy), less
// Coinbase's analytics host. Next's own inline scripts need 'unsafe-inline'.
// The full policy applies to the production build; the development server
// (which needs eval for fast refresh) only refuses to be framed.
//
// Cloudflare's Web Analytics beacon, which the 25th.dev zone injects into
// pages, gets the two hosts Cloudflare lists for it
// (developers.cloudflare.com/fundamentals/reference/policies-compliances/content-security-policies/):
// "script-src static.cloudflareinsights.com; connect-src cloudflareinsights.com".
// The injected beacon loads from static.cloudflareinsights.com/beacon.min.js/<version>
// and reports to /cdn-cgi/rum on this origin, which 'self' already covers.
const CLOUDFLARE_ANALYTICS = { script: "https://static.cloudflareinsights.com", connect: "https://cloudflareinsights.com" };

const WALLETCONNECT = ["walletconnect.com", "walletconnect.org"];
const both = (sub, scheme = "https") => WALLETCONNECT.map((d) => `${scheme}://${sub}.${d}`);
const REOWN_API = ["https://api.web3modal.com", "https://api.web3modal.org"];

const FRAMES = ["https://auth.privy.io", ...both("verify"), ...both("secure")];

const CONNECT = [
  "'self'",
  "https://auth.privy.io",
  "https://*.rpc.privy.systems",
  "wss://www.walletlink.org",
  "https://explorer-api.walletconnect.com",
  ...both("relay"),
  ...both("relay", "wss"),
  ...both("rpc"),
  ...both("pulse"),
  ...both("keys"),
  ...both("notify"),
  ...both("echo"),
  ...both("push"),
  ...REOWN_API,
  CLOUDFLARE_ANALYTICS.connect,
];

const IMAGES = ["'self'", "data:", "blob:", ...WALLETCONNECT.map((d) => `https://${d}`), ...both("secure"), "https://explorer-api.walletconnect.com", ...REOWN_API];

const CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com ${CLOUDFLARE_ANALYTICS.script}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src ${IMAGES.join(" ")}`,
  "font-src 'self' https://fonts.reown.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  `child-src ${FRAMES.join(" ")}`,
  `frame-src ${FRAMES.join(" ")} https://challenges.cloudflare.com`,
  `connect-src ${CONNECT.join(" ")}`,
  "worker-src 'self'",
  "manifest-src 'self'",
].join("; ");

export const MOVED_TO_APP = ["chat", "board", "agents", "installations", "approvals", "jobs", "wallet", "connections", "admin"];

// What the pages may use of the browser: none of the camera, microphone,
// location, payment requests, USB or the ad topics. Clipboard writes stay
// (the copy buttons); sign-in (Privy, email only) needs none of these.
export const PERMISSIONS_POLICY = "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=(), interest-cohort=()";

// HTTPS only, for two years, the site and anything under it (production
// only: the development server is plain http on localhost). Not preloaded.
export const HSTS = "max-age=63072000; includeSubDomains";

export const SECURITY_HEADERS = (production) => [
  { key: "Content-Security-Policy", value: production ? CSP : "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: PERMISSIONS_POLICY },
  ...(production ? [{ key: "Strict-Transport-Security", value: HSTS }] : []),
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Never expose server-only secrets to the client. Only NEXT_PUBLIC_* reach
  // the browser bundle, and those are enumerated in .env.example.
  poweredByHeader: false,
  experimental: {
    // Loaded from node_modules at run time, not bundled: pg, the agent
    // sandbox's QuickJS, which reads its WebAssembly file from its package,
    // and PGlite, the in-memory Postgres of the development-only live demo
    // (never imported by a production build).
    serverComponentsExternalPackages: ["pg", "quickjs-emscripten-core", "@jitl/quickjs-wasmfile-release-sync", "@electric-sql/pglite"],
    // src/instrumentation.ts: payments and the agents' job worker boot when
    // the server starts.
    instrumentationHook: true,
  },
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS(process.env.NODE_ENV === "production") }];
  },
  // The app moved under /app. Old addresses (bookmarks, links in messages,
  // published pages) move there for good, query string and all. Nothing
  // outside services call is here: /api, /h/:slug and /login stay put.
  async redirects() {
    return MOVED_TO_APP.flatMap((page) => [
      { source: `/${page}`, destination: `/app/${page}`, permanent: true },
      { source: `/${page}/:path*`, destination: `/app/${page}/:path*`, permanent: true },
    ]);
  },
};

export default nextConfig;
