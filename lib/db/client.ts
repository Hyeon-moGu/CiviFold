// Author: HyeonMo Gu
// Created: 2026-10-27

// Postgres (Neon, through the Vercel Marketplace) when DATABASE_URL is set; otherwise PGlite, an
// in-process Postgres kept under .cache/pglite, so development and tests need no account or server.
import path from "node:path";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

const MIGRATIONS = path.join(process.cwd(), "lib/db/migrations");

// Kept on globalThis: Next bundles routes separately in development, and two PGlite instances on one
// directory would corrupt it.
const shared = globalThis as typeof globalThis & { civifoldDb?: Promise<Db> };

/** The shared connection. Local PGlite migrates itself on first use; Neon is migrated by `npm run seed`. */
export function db(): Promise<Db> {
  shared.civifoldDb ??= process.env.DATABASE_URL ? openPostgres(process.env.DATABASE_URL) : openPglite(path.join(process.cwd(), ".cache/pglite"));
  return shared.civifoldDb;
}

async function openPostgres(url: string): Promise<Db> {
  const { default: postgres } = await import("postgres");
  const { drizzle } = await import("drizzle-orm/postgres-js");
  // Neon's pooled endpoint (PgBouncer) does not keep prepared statements across transactions.
  return drizzle(postgres(url, { prepare: false, max: 5 }), { schema }) as unknown as Db;
}

/** A PGlite database; `dir` null keeps it in memory (tests). */
export async function openPglite(dir: string | null): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const client = dir ? new PGlite(dir) : new PGlite();
  const database = drizzle(client, { schema });
  await migrate(database, { migrationsFolder: MIGRATIONS });
  return database as unknown as Db;
}

export async function migratePostgres(url: string): Promise<void> {
  const { default: postgres } = await import("postgres");
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");
  const client = postgres(url, { prepare: false, max: 1 });
  try {
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS });
  } finally {
    await client.end();
  }
}
