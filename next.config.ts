// Author: HyeonMo Gu
// Created: 2026-10-27

import type { NextConfig } from "next";

const config: NextConfig = {
  // Server-only packages with native or WASM parts: load them from node_modules instead of bundling.
  serverExternalPackages: ["sharp", "@meta-sam/parser", "@electric-sql/pglite", "postgres"],
  // Prompts and migrations are read from disk at runtime, which file tracing cannot see.
  outputFileTracingIncludes: { "/**": ["./prompts/*.md", "./lib/db/migrations/**/*"] },
  // The dataset's photos and recordings are served from the blob store once seeded, and the local caches,
  // results and README media never run on a deployment. Traced in, they put 300 MB into every function.
  outputFileTracingExcludes: { "/**": ["./dataset/images/**", "./dataset/voice/**", "./.cache/**", "./eval/**", "./coverage/**", "./media/**"] },
  poweredByHeader: false,
  headers: async () => [
    // No page of the app belongs in another site's frame, and the browser may use only what the form asks for
    // (the recorder, "My location" and the camera behind the photo field).
    {
      source: "/(.*)",
      headers: [
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: "camera=(self), microphone=(self), geolocation=(self), payment=(), usb=()" },
      ],
    },
    // The staff console and residents' tracking pages are not for search engines, whatever robots.txt is obeyed.
    ...["/admin", "/admin/:path*", "/track/:path*"].map((source) => ({ source, headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }] })),
  ],
};

export default config;
