// Author: HyeonMo Gu
// Created: 2026-10-28

import { z } from "zod";
import { handle } from "@/lib/server/http";
import { limit } from "@/lib/server/rate-limit";
import { reanalyzeReport, UserError } from "@/lib/server/reports";
import { runtime as app } from "@/lib/server/runtime";

export const runtime = "nodejs";
export const maxDuration = 300; // a live fast-path run can take a minute or two

const Body = z.object({ analysis_id: z.number().int() });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const body = Body.safeParse(await req.json().catch(() => null));
    if (!body.success) throw new UserError("Which analysis to replace is missing.");
    const rt = await app();
    await limit(rt.database, req, "live");
    return reanalyzeReport(rt, (await params).id, body.data.analysis_id);
  });
}
