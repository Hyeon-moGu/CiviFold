// Author: HyeonMo Gu
// Created: 2026-10-27

// Resets the demo database to the seeded world. Uses Neon and Vercel Blob when DATABASE_URL and
// BLOB_READ_WRITE_TOKEN are set (e.g. pulled with `vercel env pull`), local PGlite and .cache/blobs otherwise.
// Usage: npm run seed
import { blobs } from "../lib/db/blobs";
import { db, migratePostgres } from "../lib/db/client";
import { loadAssets } from "../lib/dataset/assets";
import { seedDemo, uploadDataset, uploadVoices } from "../lib/demo/seed";

async function main() {
  if (process.env.DATABASE_URL) await migratePostgres(process.env.DATABASE_URL);
  const uploaded = await uploadDataset(await blobs());
  if (uploaded > 0) console.log(`uploaded ${uploaded} dataset photos`);
  const voices = await uploadVoices(await blobs());
  if (voices > 0) console.log(`uploaded ${voices} sample recordings`);
  const result = await seedDemo(await db(), await loadAssets());
  console.log(`seeded ${result.incidents} open incidents into ${process.env.DATABASE_URL ? "Postgres (DATABASE_URL)" : "local PGlite (.cache/pglite)"}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
