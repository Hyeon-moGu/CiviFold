// Author: HyeonMo Gu
// Created: 2026-10-30

import type { MetadataRoute } from "next";

// Keeps well-behaved crawlers off the API and the staff console; the public pages stay indexable.
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", allow: "/", disallow: ["/api/", "/admin", "/admin/", "/track/"] } };
}
