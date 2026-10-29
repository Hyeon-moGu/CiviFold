// Author: HyeonMo Gu
// Created: 2026-10-29

import { beforeAll, describe, expect, it } from "vitest";
import { openPglite, type Db } from "../db/client";
import { claimReset, RESET_COOLDOWN_MS } from "./seed";

let database: Db;

beforeAll(async () => {
  database = await openPglite(null);
}, 60_000);

describe("public reset cooldown", () => {
  it("lets the first reset through, holds the next one for the cooldown, then lets it through again", async () => {
    const t0 = new Date("2026-10-29T10:00:00Z");
    expect(await claimReset(database, t0)).toBe(0);
    const wait = await claimReset(database, new Date(t0.getTime() + 10_000));
    expect(wait).toBe(Math.ceil((RESET_COOLDOWN_MS - 10_000) / 1000));
    expect(await claimReset(database, new Date(t0.getTime() + RESET_COOLDOWN_MS))).toBe(0);
  });
});
