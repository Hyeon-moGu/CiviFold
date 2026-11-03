// Author: HyeonMo Gu
// Created: 2026-10-27

import { handle } from "@/lib/server/http";
import { limit } from "@/lib/server/rate-limit";
import { recordRepair } from "@/lib/server/reports";
import { runtime as app } from "@/lib/server/runtime";

export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const rt = await app();
    await limit(rt.database, req, "staff");
    await recordRepair(rt, (await params).id);
    return { ok: true };
  });
}
