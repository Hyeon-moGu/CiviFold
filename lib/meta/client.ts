// Author: HyeonMo Gu
// Created: 2026-10-27

import OpenAI from "openai";

// Every Meta Model API call goes through lib/meta/*.
export const META_BASE_URL = "https://api.meta.ai/v1";

export const MODELS = {
  spark: "muse-spark-1.3",
  sam: "sam-3.1",
  image: "muse-image-1.0",
} as const;

export class MetaHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function apiKey(): string {
  const key = process.env.MODEL_API_KEY;
  if (!key) throw new Error("MODEL_API_KEY is not set (expected in .env.local)");
  return key;
}

let client: OpenAI | undefined;

// SDK retries are off: withRetry in retry.ts is the only retry layer, so cost is counted once per attempt.
export function meta(): OpenAI {
  client ??= new OpenAI({ apiKey: apiKey(), baseURL: META_BASE_URL, maxRetries: 0 });
  return client;
}

/** Raw JSON POST for endpoints whose request shape the SDK types do not cover. */
export async function metaPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${META_BASE_URL}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new MetaHttpError(res.status, `${path} → HTTP ${res.status}: ${text.slice(0, 800)}`);
  return JSON.parse(text) as T;
}
