// Author: HyeonMo Gu
// Created: 2026-10-29

import { demoState } from "@/lib/demo/scenarios";
import { handle } from "@/lib/server/http";
import { runtime as app } from "@/lib/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// What each demo step has done so far, so the page shows the shared world as it is when it opens.
export async function GET() {
  return handle(async () => demoState(await app()));
}
