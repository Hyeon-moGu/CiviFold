// Author: HyeonMo Gu
// Created: 2026-10-27

import { cacheKey, cacheStore } from "./cache";
import { withRetry, type RetryOptions } from "./retry";

// live: always call and refresh the cache. cached: cache only, a miss is an error.
// cached_then_live: cache first, call on a miss (the demo deployment runs this way).
export type Mode = "live" | "cached" | "cached_then_live";

export type CallInfo = { model: string; key: string; cached: boolean; usd: number; ms: number };

export class CacheMissError extends Error {}

const MODES: readonly Mode[] = ["live", "cached", "cached_then_live"];

export function defaultMode(): Mode {
  const mode = process.env.MODE ?? "cached_then_live";
  if (!MODES.includes(mode as Mode)) throw new Error(`MODE must be one of ${MODES.join(", ")}, got "${mode}"`);
  return mode as Mode;
}

let spentUsd = 0;

/** USD spent on live calls in this process. */
export const spent = (): number => spentUsd;

export async function metaCall<T>(opts: {
  model: string;
  request: unknown;
  send: () => Promise<T>;
  cost: (response: T) => number;
  validate?: (response: T) => void; // throw RetryableError to try again
  mode?: Mode;
  retry?: RetryOptions;
}): Promise<{ response: T; call: CallInfo }> {
  const start = Date.now();
  const mode = opts.mode ?? defaultMode();
  const key = cacheKey({ model: opts.model, request: opts.request });
  const info = (cached: boolean, usd: number): CallInfo => ({ model: opts.model, key, cached, usd, ms: Date.now() - start });

  if (mode !== "live") {
    const hit = await cacheStore().get(key);
    if (hit) return { response: hit.response as T, call: info(true, 0) };
    if (mode === "cached") throw new CacheMissError(`No cached ${opts.model} response for ${key.slice(0, 12)}`);
  }

  // Attempts rejected by validate were still billed, so cost is added per attempt.
  let usd = 0;
  try {
    const response = await withRetry(async () => {
      const res = await opts.send();
      usd += opts.cost(res);
      opts.validate?.(res);
      return res;
    }, opts.retry);
    await cacheStore().set(key, { model: opts.model, response, created_at: new Date().toISOString() });
    return { response, call: info(false, usd) };
  } finally {
    spentUsd += usd;
  }
}
