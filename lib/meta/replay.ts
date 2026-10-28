// Author: HyeonMo Gu
// Created: 2026-10-28

import { cacheKey, stableJson } from "./cache";

// The app mints report, image and incident ids at random and stamps real times, so an agent turn of the
// same demo step never repeats its request byte for byte. The replay form names those ids in order of first
// appearance and drops the times. A turn is stored in that form too, and the ids of the run replaying it are
// put back. What is sent to the model is unchanged.
const MINTED = /\b(?:rep|img|inc)_[0-9a-f]{10,12}\b/g;
const TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const ALIAS = /@@id(\d+)@@/g;

export type Replay<T> = { key: string; store: (response: T) => unknown; restore: (stored: unknown) => T };

export function replayForm<T>(request: unknown): Replay<T> {
  const ids: string[] = [];
  const aliasOf = new Map<string, string>();
  const alias = (id: string) => {
    let a = aliasOf.get(id);
    if (!a) {
      a = `@@id${ids.length}@@`;
      ids.push(id);
      aliasOf.set(id, a);
    }
    return a;
  };
  const canonical = stableJson(request).replace(MINTED, alias).replace(TIME, "@@time@@");
  return {
    key: cacheKey({ replay: canonical }),
    store: (response) => JSON.parse(JSON.stringify(response).replace(MINTED, (id) => aliasOf.get(id) ?? id)),
    restore: (stored) => JSON.parse(JSON.stringify(stored).replace(ALIAS, (a, n: string) => ids[Number(n)] ?? a)) as T,
  };
}
