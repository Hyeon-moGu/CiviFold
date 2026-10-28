// Author: HyeonMo Gu
// Created: 2026-10-27

import { handle } from "@/lib/server/http";
import { reportByCode, UserError } from "@/lib/server/reports";
import { runtime as app } from "@/lib/server/runtime";
import { residentView } from "@/lib/server/views";

export const runtime = "nodejs";

export async function GET(_: Request, { params }: { params: Promise<{ code: string }> }) {
  return handle(async () => {
    const detail = await reportByCode(await app(), (await params).code);
    if (!detail) throw new UserError("No report with that tracking code.");
    return residentView(detail);
  });
}
