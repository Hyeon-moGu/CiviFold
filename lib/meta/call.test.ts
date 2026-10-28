// Author: HyeonMo Gu
// Created: 2026-10-27

import { beforeEach, describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import { z } from "zod";
import { cacheKey, memoryStore, setCacheStore } from "./cache";
import { CacheMissError, defaultMode, LiveBudgetError, metaCall, metered, setLiveGate, spent } from "./call";
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

  it("makes one live call for identical concurrent requests", async () => {
    let calls = 0;
    const send = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 5));
      return `answer ${calls}`;
    };
    const [a, b] = await Promise.all([call(send, "live"), call(send, "live")]);
    expect(calls).toBe(1);
    expect(a.response).toBe(b.response);
    expect([a.call.cached, b.call.cached].sort()).toEqual([false, true]);
  });

  it("makes one live call for identical requests that arrive while the budget is being reserved", async () => {
    let reserves = 0;
    let sends = 0;
    setLiveGate({
      reserve: async (usd) => {
        reserves += 1;
        await new Promise((r) => setTimeout(r, 10)); // a database round trip, as on the web
        return { usd, day: "d" };
      },
      settle: async () => {},
    });
    try {
      const send = async () => `answer ${++sends}`;
      const [a, b] = await Promise.all([call(send, "live"), call(send, "live")]);
      expect([reserves, sends]).toEqual([1, 1]);
      expect(a.response).toBe(b.response);
    } finally {
      setLiveGate(null);
    }
  });

  it("shares a failure with concurrent duplicates and leaves nothing unhandled", async () => {
    const send = async (): Promise<string> => {
      await new Promise((r) => setTimeout(r, 5));
      throw new MetaHttpError(400, "bad request");
    };
    const results = await Promise.allSettled([call(send, "live"), call(send, "live")]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    await expect(call(send, "live")).rejects.toThrow("bad request");
  });

  it("meters concurrent work separately", async () => {
    const live = (q: number) => metaCall({ model: "m", request: { q }, send: async () => "x", cost: () => 0.01 * q, mode: "live", retry });
    const [a, b] = await Promise.all([metered(async () => { await live(1); await live(2); }), metered(() => live(4))]);
    expect(a.usd).toBeCloseTo(0.03);
    expect(b.usd).toBeCloseTo(0.04);
  });

  it("counts a nested meter toward the enclosing one", async () => {
    const live = (q: number) => metaCall({ model: "m", request: { nested: q }, send: async () => "x", cost: () => 0.01, mode: "live", retry });
    const outer = await metered(async () => {
      await live(1);
      const inner = await metered(() => live(2));
      expect(inner.usd).toBeCloseTo(0.01);
    });
    expect(outer.usd).toBeCloseTo(0.02);
  });

  it("holds an estimate before a live call and settles it with the real cost", async () => {
    let left = 0.015;
    const settled: Array<[number, number]> = [];
    setLiveGate({
      reserve: async (usd) => (usd <= left ? ((left -= usd), { usd, day: "d" }) : null),
      settle: async (hold, actual) => void (settled.push([hold.usd, actual]), (left += hold.usd - actual)),
    });
    try {
      await metaCall({ model: "m", request: { q: 1 }, send: async () => "first", cost: () => 0.01, mode: "live", retry, reserve: 0.012 });
      expect(settled).toEqual([[0.012, 0.01]]);
      await call(async () => "second", "cached_then_live"); // a cache hit needs no permission
      await expect(metaCall({ model: "m", request: { q: 2 }, send: async () => "x", cost: () => 0.01, mode: "live", retry, reserve: 0.012 })).rejects.toBeInstanceOf(LiveBudgetError);
    } finally {
      setLiveGate(null);
    }
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

describe("defaultMode", () => {
  it("is cache-only on a deployment unless CIVIFOLD_MODE says otherwise", () => {
    vi.stubEnv("CIVIFOLD_MODE", undefined);
    vi.stubEnv("VERCEL", "1");
    expect(defaultMode()).toBe("cached");
    vi.stubEnv("CIVIFOLD_MODE", "");
    expect(defaultMode()).toBe("cached");
    vi.stubEnv("CIVIFOLD_MODE", "cached_then_live");
    expect(defaultMode()).toBe("cached_then_live");
    vi.stubEnv("CIVIFOLD_MODE", "sometimes");
    expect(() => defaultMode()).toThrow(/CIVIFOLD_MODE must be one of/);
    vi.unstubAllEnvs();
  });

  it("falls back to cache first, live on a miss, locally", () => {
    vi.stubEnv("CIVIFOLD_MODE", undefined);
    vi.stubEnv("VERCEL", undefined);
    expect(defaultMode()).toBe("cached_then_live");
    vi.unstubAllEnvs();
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
