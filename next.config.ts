import type { NextConfig } from "next";

const dev = process.env.NODE_ENV !== "production";

/** The evidence bucket's origins: the browser uploads files straight to it (presigned PUT). */
function evidenceOrigins(): string {
  try {
    if (!process.env.EVIDENCE_S3_ENDPOINT) return "";
    const url = new URL(process.env.EVIDENCE_S3_ENDPOINT);
    // Path-style (the endpoint itself) and bucket-in-hostname addresses.
    return `${url.origin} ${url.protocol}//*.${url.host}`;
  } catch {
    return "";
  }
}

/**
 * Security headers on every response (PRD §5). Next.js needs inline scripts
 * and styles to start pages, so those are allowed; everything else is limited
 * to this site and the evidence bucket.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self' ${evidenceOrigins()}${dev ? " ws:" : ""}`.trim(),
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  // Off on purpose: almost every page is per-user and reads the session
  // (headers/cookies) first, so prerendered shells and component caching gain
  // little and would require Suspense around every auth check.
  cacheComponents: false,
  // Dev logging prints server action arguments, which include passwords and codes.
  logging: { serverFunctions: false },
  // Member and invitation lists are uploaded through server actions (files up to 2 MB).
  experimental: { serverActions: { bodySizeLimit: "3mb" } },
  // PDFs embed Noto Sans (it has the ₦ sign); the font files are read at runtime.
  outputFileTracingIncludes: { "/**": ["./assets/fonts/**"] },
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
