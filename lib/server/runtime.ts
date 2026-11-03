// Author: HyeonMo Gu
// Created: 2026-10-27

// Wiring for the web app: one database, one blob store, the model cache in the database when the
// app is deployed, and a daily cap on live model spend.
import { timingSafeEqual } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { blobs, type BlobStore } from "../db/blobs";
import { db, type Db } from "../db/client";
import { spend } from "../db/schema";
import { dbCache, dbData, dbImages } from "../db/stores";
import { setCacheStore } from "../meta/cache";
import { defaultMode, setLiveGate, type LiveGate, type Mode } from "../meta/call";
import { memoizedImages } from "../tools/images";
import type { ToolContext } from "../tools/types";

export type Runtime = { database: Db; store: BlobStore };

const shared = globalThis as typeof globalThis & { civifoldRuntime?: Promise<Runtime> };

export async function runtime(): Promise<Runtime> {
  shared.civifoldRuntime ??= Promise.all([db(), blobs()]).then(([database, store]) => ({ database, store }));
  const rt = await shared.civifoldRuntime;
  // Set on every call: Next may load lib/meta once per route bundle, each with its own settings.
  // Deployed, the evaluation's cached responses live in Postgres; locally the file cache under .cache/llm.
  if (process.env.DATABASE_URL) setCacheStore(dbCache(rt.database));
  setLiveGate(spendGate(rt.database, liveDailyUsd()));
  return rt;
}

const today = () => new Date().toISOString().slice(0, 10);
/** The daily cap on live model spend; 0 keeps a deployment on replays alone, and so does a deployment that sets none. */
export function liveDailyUsd(): number {
  const set = Number(process.env.LIVE_DAILY_USD);
  if (process.env.LIVE_DAILY_USD?.trim() && Number.isFinite(set) && set >= 0) return set;
  return process.env.VERCEL ? 0 : 2;
}

/** What is left of today's live model budget. */
export async function liveBudgetLeft(database: Db): Promise<number> {
  const [row] = await database.select({ usd: spend.usd }).from(spend).where(eq(spend.day, today()));
  return liveDailyUsd() - (row?.usd ?? 0);
}

/**
 * How a report's model calls run. A live report (sent with the access code, or a demo case a visitor sent while
 * today's budget held) calls the models every time, recordings or not, and keeps no recording of its own. In a replay-only deployment the others
 * replay their recorded calls first, and fall back to live calls while today's budget still holds a whole run
 * (needUsd).
 */
export async function runMode(database: Db, report: { live: boolean }, needUsd: number): Promise<Mode> {
  if (report.live) return "fresh";
  const mode = defaultMode();
  if (mode !== "cached") return mode;
  return (await liveBudgetLeft(database)) >= needUsd ? "cached_then_live" : "cached";
}

export function spendGate(database: Db, dailyUsd: number): LiveGate {
  return {
    // One conditional UPDATE, so two requests cannot both take the last of the budget.
    reserve: async (usd) => {
      const day = today();
      await database.insert(spend).values({ day, usd: 0 }).onConflictDoNothing();
      const held = await database
        .update(spend)
        .set({ usd: sql`${spend.usd} + ${usd}` })
        .where(and(eq(spend.day, day), sql`${spend.usd} + ${usd} <= ${dailyUsd}`))
        .returning({ usd: spend.usd });
      return held.length > 0 ? { usd, day } : null;
    },
    // Settled on the day the hold was taken, even when the call ends after midnight UTC.
    settle: async (hold, actual) => {
      if (actual === hold.usd) return;
      await database.update(spend).set({ usd: sql`${spend.usd} + ${actual - hold.usd}` }).where(eq(spend.day, hold.day));
    },
  };
}

export function toolContext({ database, store }: Runtime, reportId: string, mode: Mode): ToolContext {
  return {
    reportId,
    runId: null,
    mode,
    budget: { usdLeft: Infinity, deadline: Infinity },
    data: dbData(database, new Date().toISOString()),
    images: memoizedImages(dbImages(database, store)),
  };
}

/** A visitor's access code unlocks live model calls for their report. */
export function accessCodeValid(code: string | null | undefined): boolean {
  const expected = process.env.DEMO_ACCESS_CODE;
  const given = code?.trim();
  return Boolean(expected && given && sameSecret(given, expected));
}

// Constant-time once the lengths match, so response timing does not tell a guesser how many leading characters were right.
function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
