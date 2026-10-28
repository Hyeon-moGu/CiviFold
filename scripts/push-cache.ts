// Author: HyeonMo Gu
// Created: 2026-10-27

// Copies the local model cache (.cache/llm) into the deployed database, so the public demo replays
// the evaluation's results instead of calling the models. Image generation responses stay local.
// Usage: vercel env pull .env.local && npm run push-cache
import { readdir, readFile } from "node:fs/promises";
import { db } from "../lib/db/client";
import { dbCache } from "../lib/db/stores";
import type { CacheEntry } from "../lib/meta/cache";
import { MODELS } from "../lib/meta/client";

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set: pull the Vercel env first");
  const cache = dbCache(await db());
  const files = (await readdir(".cache/llm")).filter((f) => f.endsWith(".json"));
  let pushed = 0;
  for (const f of files) {
    const entry = JSON.parse(await readFile(`.cache/llm/${f}`, "utf8")) as CacheEntry;
    if (entry.model === MODELS.image) continue;
    await cache.set(f.replace(/\.json$/, ""), entry);
    pushed += 1;
  }
  console.log(`pushed ${pushed} cached model responses`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
