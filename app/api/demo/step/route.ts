// Author: HyeonMo Gu
// Created: 2026-10-27

import { z } from "zod";
import { runStep } from "@/lib/demo/scenarios";
import { handle } from "@/lib/server/http";
import { UserError } from "@/lib/server/reports";
import { runtime as app } from "@/lib/server/runtime";

export const runtime = "nodejs";
export const maxDuration = 300;

const Body = z.object({ scenario: z.string(), step: z.number().int().min(0), live: z.boolean().optional() });

export async function POST(req: Request) {
  return handle(async () => {
    const body = Body.safeParse(await req.json().catch(() => null));
    if (!body.success) throw new UserError("Unknown demo step.");
    // A send replays the recorded run; "Run it live" calls the models now, while today's budget holds.
    return runStep(await app(), body.data.scenario, body.data.step, { live: body.data.live === true });
  });
}
