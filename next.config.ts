import type { NextConfig } from "next";

// Security headers on every response. The Content-Security-Policy is sent in production builds only: the development server needs eval and sockets.
// Everything is served from this origin (no CDN, no analytics): fonts and scripts are local, so the policy can be strict about sources.
const isProd = process.env.NODE_ENV === "production";
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'", // Next.js inline bootstrap scripts; a nonce setup is a later hardening step
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:", // the signature image is a data: URL
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  ...(isProd ? [{ key: "Content-Security-Policy", value: csp }, { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }] : []),
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  cacheComponents: true,
  partialPrefetching: true,
  async redirects() {
    return [
      { source: "/", destination: "/room", permanent: false }, // the decision room is the front door (the proxy asks for sign-in first)
      // Results, Your limits and Proof became tabs of one page.
      { source: "/room/scoreboard", destination: "/room/safety?tab=results", permanent: false },
      { source: "/room/mandate", destination: "/room/safety?tab=limits", permanent: false },
      { source: "/room/evidence", destination: "/room/safety?tab=records", permanent: false },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
