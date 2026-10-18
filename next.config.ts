import type { NextConfig } from "next";

// ---------------------------------------------------------------------------
// Security headers (deployment hardening).
//   - CSP: Next's hydration bootstrap needs 'unsafe-inline' for scripts and
//     styles; ws:/wss: cover the live-link (same-origin proxied) sockets.
//     frame-ancestors allows the sandbox preview origins without opening the
//     app to arbitrary embedding (CSP supersedes X-Frame-Options).
//   - Permissions-Policy keeps camera available to same-origin (barcode
//     scanning) while killing mic/geo/payment surfaces.
//   - HSTS is a no-op over plain http and enforced once behind TLS.
// ---------------------------------------------------------------------------
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "worker-src 'self' blob:",
  "frame-ancestors 'self' https://*.space-z.ai http://localhost:* http://127.0.0.1:*",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ")

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(self), microphone=(), geolocation=(), payment=()",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
