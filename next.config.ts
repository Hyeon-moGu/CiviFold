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
};

export default config;
