// Author: HyeonMo Gu
// Created: 2026-11-04

import { beforeAll, describe, expect, it } from "vitest";
import { openPglite, type Db } from "../db/client";
import { limit, RATE_LIMITS, RateLimited, visitorOf } from "./rate-limit";

let database: Db;
beforeAll(async () => {
  database = await openPglite(null);
}, 60_000);

const MIN = 60_000;
// The start of a UTC day, so the 15-minute, hourly and daily windows all line up with it.
const DAY_START = Date.UTC(2026, 10, 4);
const from = (address: string) => new Request("http://localhost/api", { headers: { "x-vercel-forwarded-for": address } });

async function outcome(p: Promise<void>): Promise<"ok" | RateLimited> {
  try {
    await p;
    return "ok";
  } catch (err) {
    if (err instanceof RateLimited) return err;
    throw err;
  }
}

// Each check is a few database round trips, and the replay case makes a few hundred: slow on a busy machine.
describe("rate limits", { timeout: 30_000 }, () => {
  it("lets three resets through in fifteen minutes and refuses the fourth until the window ends", async () => {
    const req = from("10.0.0.1");
    const now = DAY_START + MIN;
    for (let i = 0; i < 3; i++) await limit(database, req, "reset", now);
    const refused = await outcome(limit(database, req, "reset", now));
    expect(refused).toBeInstanceOf(RateLimited);
    expect((refused as RateLimited).retryAfterS).toBe(14 * 60);
    expect((refused as RateLimited).message).toContain("too many in a short time");
    // The next window starts afresh.
    expect(await outcome(limit(database, req, "reset", DAY_START + 15 * MIN))).toBe("ok");
  });

  it("holds back only that visitor and only that action", async () => {
    const now = DAY_START + 2 * MIN;
    for (let i = 0; i < 3; i++) await limit(database, from("10.0.0.2"), "reset", now);
    expect(await outcome(limit(database, from("10.0.0.2"), "reset", now))).toBeInstanceOf(RateLimited);
    expect(await outcome(limit(database, from("10.0.0.3"), "reset", now))).toBe("ok");
    expect(await outcome(limit(database, from("10.0.0.2"), "report", now))).toBe("ok");
  });

  it("counts concurrent requests one by one", async () => {
    const req = from("10.0.0.4");
    const now = DAY_START + 3 * MIN;
    const results = await Promise.all(Array.from({ length: 10 }, () => outcome(limit(database, req, "reset", now))));
    expect(results.filter((r) => r === "ok")).toHaveLength(RATE_LIMITS.reset.windows[0]!.max);
  });

  it("blocks for an hour after three overflowed windows in an hour, however many clicks each overflow had", async () => {
    const req = from("10.0.0.5");
    const overflow = async (now: number, extra: number) => {
      for (let i = 0; i < 3; i++) await limit(database, req, "reset", now);
      const last = [];
      for (let i = 0; i < extra; i++) last.push(await outcome(limit(database, req, "reset", now)));
      return last.at(-1) as RateLimited;
    };
    // Four refused clicks in the first window are one strike, not four.
    expect((await overflow(DAY_START + MIN, 4)).message).toContain("too many in a short time");
    expect((await overflow(DAY_START + 16 * MIN, 1)).message).toContain("too many in a short time");
    const third = await overflow(DAY_START + 31 * MIN, 1);
    expect(third.message).toContain("after repeated tries");
    expect(third.retryAfterS).toBe(60 * 60);
    // A fresh window does not lift the block; the hour does.
    const held = await outcome(limit(database, req, "reset", DAY_START + 46 * MIN));
    expect((held as RateLimited).message).toContain("after repeated tries");
    expect(await outcome(limit(database, req, "reset", DAY_START + 92 * MIN))).toBe("ok");
  });

  it("never blocks demo replays, only slows them", async () => {
    const req = from("10.0.0.6");
    const { max, ms } = RATE_LIMITS.replay.windows[0]!;
    for (let w = 0; w < 4; w++) {
      const now = DAY_START + w * ms + MIN;
      for (let i = 0; i < max; i++) await limit(database, req, "replay", now);
      const refused = await outcome(limit(database, req, "replay", now));
      expect((refused as RateLimited).message).toContain("too many in a short time");
    }
  });

  it("takes the address Vercel sets over one a client could send", () => {
    const spoofed = new Request("http://localhost/api", { headers: { "x-vercel-forwarded-for": "1.1.1.1", "x-forwarded-for": "9.9.9.9" } });
    expect(visitorOf(spoofed)).toBe(visitorOf(from("1.1.1.1")));
    expect(visitorOf(spoofed)).not.toBe(visitorOf(from("9.9.9.9")));
  });
});
