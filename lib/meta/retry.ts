// Author: HyeonMo Gu
// Created: 2026-10-27

/** Thrown for a response that arrived but cannot be used (cut off, invalid JSON); worth another try. */
export class RetryableError extends Error {}

export type RetryOptions = { attempts?: number; baseMs?: number };

const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export function isRetryable(err: unknown): boolean {
  if (err instanceof RetryableError) return true;
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === "number") return RETRY_STATUS.has(status);
  // No status: the request never got an HTTP answer (fetch TypeError, SDK APIConnectionError).
  return err instanceof TypeError || (err as Error | null)?.name === "APIConnectionError";
}

export async function withRetry<T>(fn: () => Promise<T>, { attempts = 4, baseMs = 1000 }: RetryOptions = {}): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || !isRetryable(err)) throw err;
      const delay = baseMs * 2 ** (attempt - 1) * (0.5 + Math.random() / 2);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
