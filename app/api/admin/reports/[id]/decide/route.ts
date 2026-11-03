// Author: HyeonMo Gu
// Created: 2026-10-27

import { z } from "zod";
import { handle } from "@/lib/server/http";
import { limit } from "@/lib/server/rate-limit";
import { staffDecide, UserError } from "@/lib/server/reports";
import { runtime as app } from "@/lib/server/runtime";
import { RequestItem } from "@/lib/tools/types";

export const runtime = "nodejs";

const Body = z.object({
  action: z.enum(["link", "new_incident", "recurrence", "request_info", "dismiss"]),
  incident_id: z.string().nullable().default(null),
  item: RequestItem.default("wider_context"),
  // What the screen showed: its analysis, and whether it showed that an incident changed since.
  analysis_id: z.number().int().nullable(),
  facts_changed_seen: z.boolean().default(false),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const body = Body.safeParse(await req.json().catch(() => null));
    if (!body.success) throw new UserError("Unknown action, or the request does not say which suggestion it was made on. Reload the page.");
    const { action, incident_id, item, analysis_id, facts_changed_seen } = body.data;
    const rt = await app();
    await limit(rt.database, req, "staff");
    await staffDecide(rt, (await params).id, action, incident_id, item, { analysis_id, facts_changed_seen });
    return { ok: true };
  });
}
