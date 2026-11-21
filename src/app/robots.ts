import type { MetadataRoute } from "next";

/** A private portal: nothing here belongs in search results. */
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", disallow: "/" } };
}
