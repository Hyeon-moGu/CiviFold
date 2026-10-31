// Author: HyeonMo Gu
// Created: 2026-10-31

// Applies pending migrations to the deployed database and touches nothing else: no reseed, no uploads.
// Usage: npm run migrate (with DATABASE_URL set, e.g. pulled with `vercel env pull`)
import { migratePostgres } from "../lib/db/client";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set; the local PGlite database migrates itself when the app starts");
  await migratePostgres(url);
  console.log("migrations applied");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
