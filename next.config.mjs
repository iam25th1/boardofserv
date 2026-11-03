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
};

export default nextConfig;
