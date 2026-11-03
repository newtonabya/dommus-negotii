import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Off on purpose: almost every page is per-user and reads the session
  // (headers/cookies) first, so prerendered shells and component caching gain
  // little and would require Suspense around every auth check.
  cacheComponents: false,
  // Dev logging prints server action arguments, which include passwords and codes.
  logging: { serverFunctions: false },
  // Member and invitation lists are uploaded through server actions (files up to 2 MB).
  experimental: { serverActions: { bodySizeLimit: "3mb" } },
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
