// Author: HyeonMo Gu
// Created: 2026-10-27

import { AsyncLocalStorage } from "node:async_hooks";
import { cacheKey, cacheStore } from "./cache";
import { reserveFor } from "./pricing";
import type { Replay } from "./replay";
import { withRetry, type RetryOptions } from "./retry";

// live: always call and refresh the cache. cached: cache only, a miss is an error.
// cached_then_live: cache first, call on a miss. fresh: always call and keep nothing, so a visitor's live run
// never overwrites the recordings a demo reset replays.
export type Mode = "live" | "cached" | "cached_then_live" | "fresh";

export type CallInfo = { model: string; key: string; cached: boolean; usd: number; ms: number };

export class CacheMissError extends Error {}
export class LiveBudgetError extends Error {}

/**
 * Holds an estimate against the day's budget before a live call (refusing when it would not fit) and
 * settles it with the actual cost afterwards, so concurrent calls cannot all pass a nearly spent budget.
 * The web app sets one; scripts do not.
 */
export type Hold = { usd: number; day: string };
export type LiveGate = { reserve(usd: number): Promise<Hold | null>; settle(hold: Hold, actual: number): Promise<void> };
let gate: LiveGate | null = null;

export function setLiveGate(next: LiveGate | null): void {
  gate = next;
}

const MODES: readonly Mode[] = ["live", "cached", "cached_then_live"];

// A deployment without an explicit CIVIFOLD_MODE never spends credits: public visitors get cached results only.
// (Not plain MODE: Vite and Vitest set that one.) An empty value, as copied from .env.example, counts as unset.
export function defaultMode(): Mode {
  const mode = process.env.CIVIFOLD_MODE || (process.env.VERCEL ? "cached" : "cached_then_live");
  if (!MODES.includes(mode as Mode)) throw new Error(`CIVIFOLD_MODE must be one of ${MODES.join(", ")}, got "${mode}"`);
  return mode as Mode;
}

let spentUsd = 0;

// Identical requests in flight share one call: concurrent duplicates (a crop comparison that fell back to
// full photos next to the full comparison itself) would otherwise get two different answers, and the cache
// would keep whichever finished last, not the one the decision used.
const inflight = new Map<string, Promise<{ response: unknown }>>();

/** USD spent on live calls in this process. */
export const spent = (): number => spentUsd;

const meter = new AsyncLocalStorage<{ usd: number }>();

/** Runs `fn` and returns the USD its live calls spent, even while other work runs concurrently. */
export async function metered<T>(fn: () => Promise<T>): Promise<{ result: T; usd: number }> {
  const parent = meter.getStore();
  const store = { usd: 0 };
  try {
    return { result: await meter.run(store, fn), usd: store.usd };
  } finally {
    if (parent) parent.usd += store.usd; // nested meters still count toward the enclosing one
  }
}

export async function metaCall<T>(opts: {
  model: string;
  request: unknown;
  send: () => Promise<T>;
  cost: (response: T) => number;
  validate?: (response: T) => void; // throw RetryableError to try again
  mode?: Mode;
  retry?: RetryOptions;
  reserve?: number; // USD held against the daily budget while the call runs; defaults per model
  replay?: Replay<T>; // a second key that ignores minted ids and times, for agent turns
}): Promise<{ response: T; call: CallInfo }> {
  const start = Date.now();
  const mode = opts.mode ?? defaultMode();
  const key = cacheKey({ model: opts.model, request: opts.request });
  const info = (cached: boolean, usd: number): CallInfo => ({ model: opts.model, key, cached, usd, ms: Date.now() - start });

  if (mode !== "live" && mode !== "fresh") {
    const hit = await cacheStore().get(key);
    if (hit) return { response: hit.response as T, call: info(true, 0) };
    const replayed = opts.replay ? await cacheStore().get(opts.replay.key) : null;
    if (replayed) return { response: opts.replay!.restore(replayed.response), call: info(true, 0) };
    if (mode === "cached") throw new CacheMissError(`No cached ${opts.model} response for ${key.slice(0, 12)}`);
  }

  const pending = inflight.get(key);
  if (pending) return { response: (await pending).response as T, call: info(true, 0) };
  // Registered before the first await: an identical request arriving while the budget is being reserved
  // joins this call instead of reserving and paying for its own.
  const live = (async () => {
    const hold = gate ? await gate.reserve(opts.reserve ?? reserveFor(opts.model)) : null;
    if (gate && !hold) throw new LiveBudgetError(`Live model calls are paused: today's budget is used up`);
    return callLive(opts, key, info, hold, mode !== "fresh");
  })();
  inflight.set(key, live);
  try {
    return await live;
  } finally {
    inflight.delete(key);
  }
}

async function callLive<T>(
  opts: Parameters<typeof metaCall<T>>[0],
  key: string,
  info: (cached: boolean, usd: number) => CallInfo,
  hold: Hold | null,
  keep: boolean,
): Promise<{ response: T; call: CallInfo }> {
  // Attempts rejected by validate were still billed, so cost is added per attempt.
  let usd = 0;
  try {
    const response = await withRetry(async () => {
      const res = await opts.send();
      usd += opts.cost(res);
      opts.validate?.(res);
      return res;
    }, opts.retry);
    if (keep) {
      const created_at = new Date().toISOString();
      await cacheStore().set(key, { model: opts.model, response, created_at });
      if (opts.replay) await cacheStore().set(opts.replay.key, { model: opts.model, response: opts.replay.store(response), created_at });
    }
    return { response, call: info(false, usd) };
  } finally {
    spentUsd += usd;
    const store = meter.getStore();
    if (store) store.usd += usd;
    if (gate && hold) await gate.settle(hold, usd);
  }
}
