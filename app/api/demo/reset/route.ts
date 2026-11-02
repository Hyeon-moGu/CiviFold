// Author: HyeonMo Gu
// Created: 2026-10-27

import { ASSET_FILE } from "@/lib/dataset/static";
import { playAll } from "@/lib/demo/scenarios";
import { claimReset, seedDemo } from "@/lib/demo/seed";
import { handle } from "@/lib/server/http";
import { UserError } from "@/lib/server/reports";
import { runtime as app } from "@/lib/server/runtime";

export const runtime = "nodejs";
export const maxDuration = 300;

// The world is shared, so a reset under another visitor's feet is held to one a minute. A reset plays every
// scenario again from replayed model results, so the next visitor finds the results instead of a blank world.
export async function POST() {
  return handle(async () => {
    const rt = await app();
    const wait = await claimReset(rt.database);
    if (wait > 0) throw new UserError(`The demo was reset less than a minute ago, by you or another visitor. Try again in ${wait} s.`);
    const seeded = await seedDemo(rt.database, ASSET_FILE);
    const steps = await playAll(rt);
    return { ...seeded, steps };
  });
}
