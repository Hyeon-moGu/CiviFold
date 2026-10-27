// Author: HyeonMo Gu
// Created: 2026-10-27

import { beforeEach, describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import { z } from "zod";
import { cacheKey, memoryStore, setCacheStore } from "./cache";
import { CacheMissError, metaCall, spent } from "./call";
import { MetaHttpError } from "./client";
import { sparkCost } from "./pricing";
import { isRetryable, RetryableError } from "./retry";
import { parseCompletion } from "./spark";

const retry = { baseMs: 1 };

function call(send: () => Promise<string>, mode: "live" | "cached" | "cached_then_live" = "cached_then_live", validate?: (r: string) => void) {
  return metaCall({ model: "m", request: { q: 1 }, send, cost: () => 0.01, validate, mode, retry });
}

beforeEach(() => setCacheStore(memoryStore()));

describe("metaCall", () => {
  it("serves the second call from the cache at zero cost", async () => {
    const send = vi.fn(async () => "answer");
    const first = await call(send);
    const second = await call(send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(first.call).toMatchObject({ cached: false, usd: 0.01 });
    expect(second).toMatchObject({ response: "answer", call: { cached: true, usd: 0 } });
  });

  it("live mode always calls; cached mode never does", async () => {
    const send = vi.fn(async () => "answer");
    await expect(call(send, "cached")).rejects.toBeInstanceOf(CacheMissError);
    await call(send, "live");
    await call(send, "live");
    expect(send).toHaveBeenCalledTimes(2);
    await expect(call(send, "cached")).resolves.toMatchObject({ call: { cached: true } });
  });

  it("retries 503 and rejected responses, billing every attempt", async () => {
    const before = spent();
    const send = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new MetaHttpError(503, "busy"))
      .mockResolvedValueOnce("bad")
      .mockResolvedValueOnce("good");
    const validate = (r: string) => {
      if (r === "bad") throw new RetryableError("bad");
    };
    const { response, call: info } = await call(send, "live", validate);
    expect(response).toBe("good");
    expect(send).toHaveBeenCalledTimes(3);
    expect(info.usd).toBeCloseTo(0.02);
    expect(spent() - before).toBeCloseTo(0.02);
  });

  it("does not retry client errors or cache failures", async () => {
    const send = vi.fn(async (): Promise<string> => {
      throw new MetaHttpError(400, "unknown field");
    });
    await expect(call(send)).rejects.toThrow("unknown field");
    expect(send).toHaveBeenCalledTimes(1);
    await expect(call(async () => "x", "cached")).rejects.toBeInstanceOf(CacheMissError);
  });
});

describe("helpers", () => {
  it("cache keys ignore key order and undefined fields", () => {
    expect(cacheKey({ a: 1, b: [1, { c: 2, d: undefined }] })).toBe(cacheKey({ b: [1, { c: 2 }], a: 1 }));
    expect(cacheKey({ a: 1 })).not.toBe(cacheKey({ a: 2 }));
  });

  it("classifies retryable errors", () => {
    expect(isRetryable(new MetaHttpError(429, ""))).toBe(true);
    expect(isRetryable(new MetaHttpError(422, ""))).toBe(false);
    expect(isRetryable(new TypeError("fetch failed"))).toBe(true);
    expect(isRetryable(new Error("other"))).toBe(false);
  });

  it("prices Spark tokens, reasoning included in output", () => {
    expect(sparkCost("muse-spark-1.3", { input: 1_000_000, output: 1_000_000 })).toBeCloseTo(5.5);
    expect(() => sparkCost("unknown", null)).toThrow();
  });
});

describe("parseCompletion", () => {
  const schema = z.object({ ok: z.boolean() });
  const completion = (content: string | null, finish_reason = "stop") =>
    ({ choices: [{ index: 0, finish_reason, message: { role: "assistant", content, refusal: null } }] }) as unknown as OpenAI.Chat.ChatCompletion;

  it("returns validated data", () => {
    expect(parseCompletion(completion('{"ok":true}'), schema)).toEqual({ ok: true });
  });

  it("marks cut-off, empty, malformed and off-schema output as retryable", () => {
    for (const res of [completion(null, "length"), completion(null), completion("{"), completion('{"ok":"yes"}')]) {
      expect(() => parseCompletion(res, schema)).toThrow(RetryableError);
    }
  });
});
