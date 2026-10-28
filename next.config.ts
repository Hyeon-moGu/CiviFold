// Author: HyeonMo Gu
// Created: 2026-10-27

import type { NextConfig } from "next";

const config: NextConfig = {
  // Server-only packages with native or WASM parts: load them from node_modules instead of bundling.
  serverExternalPackages: ["sharp", "@meta-sam/parser", "@electric-sql/pglite", "postgres"],
  // Prompts and migrations are read from disk at runtime, which file tracing cannot see.
  outputFileTracingIncludes: { "/**": ["./prompts/*.md", "./lib/db/migrations/**/*"] },
};

export default config;
