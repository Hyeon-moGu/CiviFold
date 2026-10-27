// Author: HyeonMo Gu
// Created: 2026-10-27

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type CacheEntry = { model: string; response: unknown; created_at: string };

export type CacheStore = {
  get(key: string): Promise<CacheEntry | null>;
  set(key: string, entry: CacheEntry): Promise<void>;
};

// The key hashes the whole request, so prompt text and inlined image bytes are both part of it:
// editing a prompt or swapping an image misses the cache by construction.
export function cacheKey(request: unknown): string {
  return createHash("sha256").update(stableJson(request)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function fileStore(dir = path.resolve(".cache/llm")): CacheStore {
  const file = (key: string) => path.join(dir, `${key}.json`);
  return {
    async get(key) {
      try {
        return JSON.parse(await readFile(file(key), "utf8")) as CacheEntry;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },
    async set(key, entry) {
      await mkdir(dir, { recursive: true });
      await writeFile(file(key), JSON.stringify(entry));
    },
  };
}

export function memoryStore(): CacheStore {
  const entries = new Map<string, CacheEntry>();
  return {
    get: async (key) => entries.get(key) ?? null,
    set: async (key, entry) => void entries.set(key, entry),
  };
}

let store: CacheStore = fileStore();

export const cacheStore = (): CacheStore => store;

export function setCacheStore(next: CacheStore): void {
  store = next;
}
