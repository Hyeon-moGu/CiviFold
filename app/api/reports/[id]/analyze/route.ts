// Author: HyeonMo Gu
// Created: 2026-10-27

import { handle } from "@/lib/server/http";
import { limit } from "@/lib/server/rate-limit";
import { analyzeReport, goLive } from "@/lib/server/reports";
import { runtime as app } from "@/lib/server/runtime";

export const runtime = "nodejs";
export const maxDuration = 300; // a live run (triage, SAM and several comparisons) can take a minute or two

// With an access code in the body, a report the public demo could not check runs live.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const [rt, { id }] = await Promise.all([app(), params]);
    const body = (await req.json().catch(() => null)) as { access_code?: unknown } | null;
    if (typeof body?.access_code === "string") {
      await limit(rt.database, req, "live");
      await goLive(rt, id, body.access_code);
    }
    return analyzeReport(rt, id);
  });
}
