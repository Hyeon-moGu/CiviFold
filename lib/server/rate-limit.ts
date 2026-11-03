// Author: HyeonMo Gu
// Created: 2026-11-04

// Holds each visitor (an address, hashed) to a pace per action, so one visitor cannot reset the shared demo world
// over and over, flood it with reports, or spend the day's live budget alone. The limits are generous because
// judges behind one company address share it. Overuse holds back that one action: pages stay open, and so do
// the other actions.
import { createHash } from "node:crypto";
import { eq, lt, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { rateBlocks, rateCounts } from "../db/schema";
import { UserError } from "./reports";

export type RateAction = "reset" | "report" | "live" | "replay" | "staff";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// strikes: whether sustained overuse holds the action back (BLOCK) rather than only refusing until the window ends.
export const RATE_LIMITS: Record<RateAction, { windows: Array<{ ms: number; max: number }>; strikes: boolean }> = {
  reset: { windows: [{ ms: 15 * MIN, max: 3 }, { ms: DAY, max: 10 }], strikes: true },
  report: { windows: [{ ms: 10 * MIN, max: 30 }, { ms: DAY, max: 150 }], strikes: true },
  // Every call that can reach the models: "Run it live", an upload with the access code, the agents, a re-analysis.
  live: { windows: [{ ms: 10 * MIN, max: 20 }, { ms: DAY, max: 60 }], strikes: true },
  replay: { windows: [{ ms: 10 * MIN, max: 60 }], strikes: false },
  staff: { windows: [{ ms: 10 * MIN, max: 60 }], strikes: false },
};

// A strike is a window overflowed, not a refused request: three overflowed windows within an hour hold the
// action back for an hour, while clicking again inside one full window adds nothing.
export const STRIKES = { max: 3, ms: HOUR, block_ms: HOUR };

const WHAT: Record<RateAction, string> = {
  reset: "Resetting the demo is",
  report: "Sending reports is",
  live: "Running the models live is",
  replay: "Sending demo cases is",
  staff: "Staff actions are",
};

export class RateLimited extends UserError {
  constructor(
    message: string,
    readonly retryAfterS: number,
  ) {
    super(message, "rate");
  }
}

/** The visitor's address, hashed: Vercel sets the first header itself, so a client cannot choose its own. */
export function visitorOf(req: Request): string {
  const h = req.headers;
  const address = h.get("x-vercel-forwarded-for") ?? h.get("x-real-ip") ?? h.get("x-forwarded-for")?.split(",")[0] ?? "local";
  return createHash("sha256").update(`civifold:${address.trim()}`).digest("hex").slice(0, 20);
}

function refused(action: RateAction, ms: number, held: boolean): RateLimited {
  const minutes = Math.max(1, Math.ceil(ms / MIN));
  const why = held ? "after repeated tries" : "too many in a short time";
  return new RateLimited(`${WHAT[action]} paused for your network for about ${minutes} min (${why}). Everything else still works.`, Math.ceil(ms / 1000));
}

// One upsert per window: concurrent requests each get their own count, so none slips past the limit.
async function bump(database: Db, key: string, expiresAt: number): Promise<number> {
  const [row] = await database
    .insert(rateCounts)
    .values({ key, count: 1, expires_at: new Date(expiresAt).toISOString() })
    .onConflictDoUpdate({ target: rateCounts.key, set: { count: sql`${rateCounts.count} + 1` } })
    .returning({ count: rateCounts.count });
  return row!.count;
}

/** Counts one request of `action` for its visitor, or refuses it (RateLimited) when the visitor is over a limit. */
export async function limit(database: Db, req: Request, action: RateAction, now = Date.now()): Promise<void> {
  const rule = RATE_LIMITS[action];
  const who = `${action}:${visitorOf(req)}`;
  const [block] = await database.select({ until: rateBlocks.until }).from(rateBlocks).where(eq(rateBlocks.key, who));
  if (block && Date.parse(block.until) > now) throw refused(action, Date.parse(block.until) - now, true);
  for (const w of rule.windows) {
    const n = Math.floor(now / w.ms);
    const end = (n + 1) * w.ms;
    const count = await bump(database, `${who}:${w.ms}:${n}`, end);
    if (count <= w.max) continue;
    if (rule.strikes && count === w.max + 1) {
      const hour = Math.floor(now / STRIKES.ms);
      const strikes = await bump(database, `${who}:strike:${hour}`, (hour + 1) * STRIKES.ms);
      if (strikes >= STRIKES.max) {
        const until = new Date(now + STRIKES.block_ms).toISOString();
        await database.insert(rateBlocks).values({ key: who, until }).onConflictDoUpdate({ target: rateBlocks.key, set: { until } });
        throw refused(action, STRIKES.block_ms, true);
      }
    }
    throw refused(action, end - now, false);
  }
  // Now and then, drop counts whose windows have ended.
  if (Math.random() < 0.02) await database.delete(rateCounts).where(lt(rateCounts.expires_at, new Date(now).toISOString()));
}

/** For the streaming routes, which answer before handle() could: the 429 to send, or null to go on. */
export async function limitResponse(database: Db, req: Request, action: RateAction): Promise<Response | null> {
  try {
    await limit(database, req, action);
    return null;
  } catch (err) {
    if (!(err instanceof RateLimited)) throw err;
    return Response.json({ error: err.message, code: "rate", retry_after: err.retryAfterS }, { status: 429, headers: { "Retry-After": String(err.retryAfterS) } });
  }
}
