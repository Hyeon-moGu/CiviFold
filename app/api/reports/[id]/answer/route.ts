// Author: HyeonMo Gu
// Created: 2026-10-27

import { handle, isoTime, photoFrom, text } from "@/lib/server/http";
import { analyzeReport, answerReport, UserError } from "@/lib/server/reports";
import { runtime as app } from "@/lib/server/runtime";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const id = (await params).id;
    const rt = await app();
    const form = await req.formData();
    const photo = await photoFrom(form);
    const observed = text(form, "observed_at");
    if (photo) await answerReport(rt, id, { photo, access_code: text(form, "access_code") });
    else if (observed) await answerReport(rt, id, { observed_at: isoTime(observed, new Date().toISOString()) });
    else throw new UserError("Add the photo or the time we asked for.");
    return analyzeReport(rt, id);
  });
}
