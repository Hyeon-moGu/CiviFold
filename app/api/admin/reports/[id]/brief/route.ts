// Author: HyeonMo Gu
// Created: 2026-11-01

import { z } from "zod";
import { briefReport, type BriefEvent } from "@/lib/server/briefs";
import { UserError } from "@/lib/server/reports";
import { runtime as app } from "@/lib/server/runtime";

export const runtime = "nodejs";
// One agent run is capped at 120 s.
export const maxDuration = 300;

const Body = z.object({ analysis_id: z.number().int() });

// Streams one JSON line per finished tool call, then the result, as the verify route does. If the screen
// goes away the run goes on and its brief is stored as usual.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return Response.json({ error: "Which analysis to brief is missing." }, { status: 400 });
  const [rt, { id }] = await Promise.all([app(), params]);
  const encoder = new TextEncoder();
  let watching = true;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: BriefEvent) => {
        if (!watching) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          watching = false;
        }
      };
      try {
        const result = await briefReport(rt, id, body.data.analysis_id, ({ step, ref, tool, ok, error, args, data }) =>
          send({ type: "step", step: { step, ref, tool, ok, error, args, data } }),
        );
        send({ type: "result", result });
      } catch (err) {
        if (!(err instanceof UserError)) console.error(err);
        send({ type: "error", error: err instanceof UserError ? err.message : "Something went wrong on our side." });
      }
      if (watching) controller.close();
    },
    cancel() {
      watching = false;
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
}
