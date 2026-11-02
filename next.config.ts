import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Off on purpose: almost every page is per-user and reads the session
  // (headers/cookies) first, so prerendered shells and component caching gain
  // little and would require Suspense around every auth check.
  cacheComponents: false,
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
