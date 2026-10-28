// Author: HyeonMo Gu
// Created: 2026-10-27

import { handle } from "@/lib/server/http";
import { analyzeReport } from "@/lib/server/reports";
import { runtime as app } from "@/lib/server/runtime";

export const runtime = "nodejs";
export const maxDuration = 300; // a live run (triage, SAM and several comparisons) can take a minute or two

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => analyzeReport(await app(), (await params).id));
}
